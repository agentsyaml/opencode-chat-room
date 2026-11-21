import { mkdirSync, mkdtempSync, promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

// Run the fixtures in a child process with only the sandbox env, so the real
// user state and any ambient center configuration are never touched.
if (process.env.CHAT_ROOM_JOIN_APPROVAL_CHILD !== "1") {
  test("runs join approval fixtures in an isolated process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "chat-room-test-env-join-"));
    for (const name of ["home", "config", "state", "rooms"]) mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, ".sandbox"), "1");
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(dir, "home"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_STATE_HOME: path.join(dir, "state"),
        CHAT_ROOM_STATE_DIR: path.join(dir, "rooms"),
        CHAT_ROOM_SERVER_TOKEN: "join-approval-token",
        CHAT_ROOM_TEST_ISOLATED: "1",
        CHAT_ROOM_TEST_SANDBOX: dir,
        CHAT_ROOM_JOIN_APPROVAL_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`${stdout}${stderr}`);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited.catch(() => {});
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
} else {
  const { default: server } = await import("../../server/chat-server");
  const store = await import("../state/store.ts");
  const token = "join-approval-token";

  const call = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    server.fetch(new Request(`http://local${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  const createRoom = async (name: string, policy?: "open" | "approval", sessionID = "owner-session") => {
    const response = await call("/rooms", "POST", { name, ownerId: "owner", sessionID, ...(policy ? { joinPolicy: policy } : {}) });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; joinPolicy: string; participants: Array<{ name: string }> };
  };

  const join = (roomID: string, sessionID: string, name: string, extra: Record<string, unknown> = {}) =>
    call(`/rooms/${roomID}/join`, "POST", { sessionID, participantId: name, participantName: name, ...extra });

  const statusOf = async (roomID: string, sessionID: string) =>
    await (await call(`/rooms/${roomID}/join-requests/status?sessionID=${encodeURIComponent(sessionID)}`)).json() as { status: string };

  const requestsOf = async (roomID: string, sessionID: string, headers: Record<string, string> = {}) => {
    const response = await call(`/rooms/${roomID}/join-requests?sessionID=${encodeURIComponent(sessionID)}`, "GET", undefined, headers);
    expect(response.status).toBe(200);
    return await response.json() as { requests: Array<{ sessionID: string; participantId: string; name: string; isAgent: boolean }> };
  };

  describe.serial("join approval", () => {
    test("exposes join_status on both OpenCode room schemas", async () => {
      const { roomArgs } = await import("../../plugin");
      const { roomSchema } = await import("../runtime/v2-plugin.ts");
      for (const schema of [roomArgs, roomSchema()]) {
        expect(schema.safeParse({ action: "join_status", roomId: "room-1" }).success).toBe(true);
      }
    });

    test("exposes an approved V2 session to its receiver owner", async () => {
      const ownerID = "123e4567-e89b-42d3-a456-426614174000";
      const room = await createRoom("approval-v2", "approval");
      expect((await join(room.id, "v2-session", "v2-agent", { protocol: "v2", receiverOwnerID: ownerID })).status).toBe(202);
      expect((await call(`/rooms/${room.id}/join-requests/v2-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(200);
      const memberships = await (await call(`/receiver/memberships?ownerID=${ownerID}`)).json() as { sessionIDs: string[] };
      expect(memberships.sessionIDs).toContain("v2-session");
      const inbox = await (await call(`/inbox?sessionID=v2-session&roomId=${room.id}&excludeSelf=1&timeout=0`)).json() as {
        member: boolean;
        items: Array<{ text: string }>;
      };
      expect(inbox.member).toBe(true);
      expect(inbox.items).toContainEqual(expect.objectContaining({ text: "v2-agent joined the room" }));
    });

    test("keeps rooms without a policy open and persists the approval policy", async () => {
      const legacy = await createRoom("legacy-open");
      expect(legacy.joinPolicy).toBe("open");
      expect((await join(legacy.id, "bob", "bob")).status).toBe(201);
      const inbox = await (await call(`/inbox?sessionID=bob&roomId=${legacy.id}&excludeSelf=1&timeout=0`)).json() as {
        items: Array<{ text: string }>;
      };
      expect(inbox.items.some((item) => item.text === "bob joined the room")).toBe(false);

      const guarded = await createRoom("guarded", "approval");
      expect(guarded.joinPolicy).toBe("approval");
      expect(guarded.participants.map((participant) => participant.name)).toEqual(["owner"]);
      expect((await call(`/rooms/${guarded.id}`, "GET")).status).toBe(200);
      expect(((await (await call(`/rooms/${guarded.id}`, "GET")).json()) as { joinPolicy: string }).joinPolicy).toBe("approval");
    });

    test("holds a new human request outside the registry until a human admin approves", async () => {
      const room = await createRoom("approval-basic", "approval");
      const pending = await join(room.id, "bob-session", "bob");
      expect(pending.status).toBe(202);
      expect(await pending.json()).toEqual({
        status: "pending",
        message: "Join request submitted. You are not a member yet; a human administrator must approve it before you can send or poll.",
      });
      expect(await statusOf(room.id, "bob-session")).toEqual({ status: "pending" });
      expect(await store.readState((svc, registry) => ({
        participants: svc.getParticipants(room.id).map((participant) => participant.name),
        entry: registry[room.id]?.["bob-session"],
      }))).toEqual({ participants: ["owner"], entry: undefined });

      expect((await call(`/rooms/${room.id}/join-requests?sessionID=bob-session`)).status).toBe(403);
      expect((await call(`/rooms/${room.id}/join-requests/bob-session/approve`, "POST", { sessionID: "bob-session" })).status).toBe(403);
      const listed = await requestsOf(room.id, "owner-session");
      expect(listed.requests).toEqual([
        expect.objectContaining({ sessionID: "bob-session", participantId: "bob", name: "bob", isAgent: false }),
      ]);

      const approved = await call(`/rooms/${room.id}/join-requests/bob-session/approve`, "POST", { sessionID: "owner-session" });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ ok: true });
      expect(await statusOf(room.id, "bob-session")).toEqual({ status: "joined" });
      const approvedState = await store.readState((svc, registry) => ({
        participants: svc.getParticipants(room.id).map((participant) => participant.name).sort(),
        membership: registry[room.id]?.["bob-session"]?.membershipID,
      }));
      expect(approvedState.participants).toEqual(["bob", "owner"]);
      expect(approvedState.membership).toEqual(expect.any(String));
      const inbox = await (await call(`/inbox?sessionID=bob-session&roomId=${room.id}&excludeSelf=1&timeout=0`)).json() as {
        member: boolean;
        items: Array<{ text: string }>;
      };
      expect(inbox.member).toBe(true);
      expect(inbox.items).toContainEqual(expect.objectContaining({ text: "bob joined the room" }));
      expect((await join(room.id, "bob-session", "bob")).status).toBe(201);
      expect(await requestsOf(room.id, "owner-session")).toEqual({ requests: [] });
    });

    test("lets only the requester cancel a pending request", async () => {
      const room = await createRoom("approval-cancel", "approval");
      expect((await join(room.id, "carol-session", "carol")).status).toBe(202);
      expect((await call(`/rooms/${room.id}/join-requests?sessionID=bob-session`, "DELETE", {})).status).toBe(404);
      expect(await statusOf(room.id, "carol-session")).toEqual({ status: "pending" });
      const cancelled = await call(`/rooms/${room.id}/join-requests?sessionID=carol-session`, "DELETE", {});
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ ok: true });
      expect(await statusOf(room.id, "carol-session")).toEqual({ status: "none" });
      expect(await requestsOf(room.id, "owner-session")).toEqual({ requests: [] });
      expect((await call(`/rooms/${room.id}/join-requests?sessionID=carol-session`, "DELETE", {})).status).toBe(404);
      expect((await join(room.id, "carol-session", "carol")).status).toBe(202);
    });

    test("clears a denied request so the same session can retry", async () => {
      const room = await createRoom("approval-deny", "approval");
      expect((await join(room.id, "carol-session", "carol")).status).toBe(202);
      const denied = await call(`/rooms/${room.id}/join-requests/carol-session/deny`, "POST", { sessionID: "owner-session" });
      expect(denied.status).toBe(200);
      expect(await statusOf(room.id, "carol-session")).toEqual({ status: "none" });
      expect((await call(`/rooms/${room.id}/join-requests/carol-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(404);

      expect((await join(room.id, "carol-session", "carol-renamed")).status).toBe(202);
      expect((await requestsOf(room.id, "owner-session")).requests.map((request) => request.name)).toEqual(["carol-renamed"]);
      expect((await call(`/rooms/${room.id}/join-requests/carol-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(200);
      expect(await statusOf(room.id, "carol-session")).toEqual({ status: "joined" });
    });

    test("rejects a pending request that would reuse an existing member identity", async () => {
      const room = await createRoom("approval-collision", "approval");
      expect((await join(room.id, "faker", "owner")).status).toBe(409);
      expect(await statusOf(room.id, "faker")).toEqual({ status: "none" });
      expect((await join(room.id, "first", "dave")).status).toBe(202);
      expect((await join(room.id, "second", "dave")).status).toBe(409);
      expect((await requestsOf(room.id, "owner-session")).requests.map((request) => request.sessionID)).toEqual(["first"]);
    });

    test("lets a delegated human admin review and opening the room clears pending requests", async () => {
      const room = await createRoom("approval-delegated", "approval");
      expect((await join(room.id, "erin-session", "erin")).status).toBe(202);
      expect((await call(`/rooms/${room.id}/join-requests/erin-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(200);
      const madeAdmin = await call(`/rooms/${room.id}`, "PATCH", { sessionID: "owner-session", adminIds: ["erin"] });
      expect(madeAdmin.status).toBe(200);
      expect((await join(room.id, "frank-session", "frank")).status).toBe(202);
      expect((await requestsOf(room.id, "erin-session")).requests.map((request) => request.sessionID)).toEqual(["frank-session"]);

      expect((await call(`/rooms/${room.id}`, "PATCH", { sessionID: "owner-session", joinPolicy: "open" })).status).toBe(200);
      expect(await requestsOf(room.id, "owner-session")).toEqual({ requests: [] });
      expect((await join(room.id, "frank-session", "frank")).status).toBe(201);
      expect((await call(`/rooms/${room.id}/join-requests/frank-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(404);
    });

    test("management agent reviews and approves agent requests only", async () => {
      const room = await createRoom("approval-agent", "approval");
      const agentOwner = "123e4567-e89b-42d3-a456-426614174000";
      const otherOwner = "123e4567-e89b-42d3-a456-426614174001";
      expect((await join(room.id, "agent-a-session", "agent-a", { protocol: "v2", receiverOwnerID: agentOwner })).status).toBe(202);
      expect((await call(`/rooms/${room.id}/join-requests/agent-a-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(200);
      expect((await call(`/rooms/${room.id}`, "PATCH", { sessionID: "owner-session", adminSessionID: "agent-a-session" })).status).toBe(200);

      expect((await join(room.id, "human-session", "human")).status).toBe(202);
      expect((await join(room.id, "agent-b-session", "agent-b", { protocol: "v2", receiverOwnerID: otherOwner, host: "host-b" })).status).toBe(202);

      const agentHeaders = { "x-chat-agent-session": "agent-a-session", "x-chat-agent-owner": agentOwner };
      expect((await call(`/rooms/${room.id}/join-requests?sessionID=agent-a-session`, "GET", undefined,
        { "x-chat-agent-session": "agent-a-session", "x-chat-agent-owner": "wrong-owner" })).status).toBe(403);
      expect((await requestsOf(room.id, "agent-a-session", agentHeaders)).requests).toEqual([
        expect.objectContaining({ sessionID: "agent-b-session", isAgent: true }),
      ]);

      expect((await call(`/rooms/${room.id}/join-requests/human-session/approve`, "POST", { sessionID: "agent-a-session" }, agentHeaders)).status).toBe(403);
      expect((await call(`/rooms/${room.id}/join-requests/human-session/deny`, "POST", { sessionID: "agent-a-session" }, agentHeaders)).status).toBe(403);
      expect(await statusOf(room.id, "human-session")).toEqual({ status: "pending" });

      expect((await call(`/rooms/${room.id}/join-requests/agent-b-session/approve`, "POST", { sessionID: "agent-a-session" }, agentHeaders)).status).toBe(200);
      expect(await statusOf(room.id, "agent-b-session")).toEqual({ status: "joined" });
      expect((await call(`/rooms/${room.id}/join-requests/human-session/approve`, "POST", { sessionID: "owner-session" })).status).toBe(200);
      expect(await statusOf(room.id, "human-session")).toEqual({ status: "joined" });
    });

    test("consumes a request once under concurrent approvals", async () => {
      const room = await createRoom("approval-race", "approval");
      expect((await join(room.id, "gina-session", "gina")).status).toBe(202);
      const results = await Promise.all([
        call(`/rooms/${room.id}/join-requests/gina-session/approve`, "POST", { sessionID: "owner-session" }),
        call(`/rooms/${room.id}/join-requests/gina-session/approve`, "POST", { sessionID: "owner-session" }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 404]);
      expect(await statusOf(room.id, "gina-session")).toEqual({ status: "joined" });
    });
  });

  afterAll(async () => {
    await fs.rm(path.dirname(store.statePath()), { recursive: true, force: true });
  });
}