import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CHAT_ROOM_STATE_DIR", "CHAT_ROOM_SERVER_URL", "CHAT_ROOM_SERVER_TOKEN", "CHAT_ROOM_WAKE_SERVE_URL"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(4)) delete process.env[key];
const stateHome = mkdtempSync(path.join(tmpdir(), "chat-room-delivery-"));
process.env.HOME = path.join(stateHome, "home");
process.env.XDG_CONFIG_HOME = path.join(stateHome, "config");
process.env.XDG_STATE_HOME = stateHome;
process.env.CHAT_ROOM_STATE_DIR = path.join(stateHome, "rooms");
const [{ acquireDeliveryLease, closeReceiverState, ownsDeliveryLease, releaseDeliveryLease, renewDeliveryLease }, queue] = await Promise.all([
  import("./receiver-state"), import("./queue"),
]);
const { assertDeliveryLease, serializeSessionPush } = await import("./session-delivery");
const spawnCode = async (source: string) => {
  const env = { ...process.env };
  delete env.CHAT_ROOM_SERVER_URL;
  delete env.CHAT_ROOM_SERVER_TOKEN;
  delete env.CHAT_ROOM_WAKE_SERVE_URL;
  const child = Bun.spawn([process.execPath, "-e", source], {
    env,
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
};

describe.serial("durable session delivery coordination", () => {
  test("cross-process leases exclude a second owner and expire without releasing a successor", async () => {
    const now = Date.now();
    expect(acquireDeliveryLease("s", "first", now, now + 60_000)).toBe(true);
    const stateUrl = new URL("./receiver-state.ts", import.meta.url).href;
    const result = await spawnCode(`const s=await import(${JSON.stringify(stateUrl)}); console.log(s.acquireDeliveryLease("s","child",Date.now(),Date.now()+1000));`);
    expect(result).toBe("false");
    expect(ownsDeliveryLease("s", "first", Date.now())).toBe(true);
    releaseDeliveryLease("s", "first");
    const crashed = await spawnCode(`const s=await import(${JSON.stringify(stateUrl)}); const t=Date.now(); console.log(s.acquireDeliveryLease("s","crashed",t,t+100));`);
    expect(crashed).toBe("true");
    expect(acquireDeliveryLease("s", "successor", Date.now(), Date.now() + 1000)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const later = Date.now();
    expect(acquireDeliveryLease("s", "successor", later, later + 1000)).toBe(true);
    expect(renewDeliveryLease("s", "crashed", later, later + 2000)).toBe(false);
    releaseDeliveryLease("s", "crashed");
    expect(ownsDeliveryLease("s", "successor", later)).toBe(true);
  });

test("pending admission identity and admitted state survive a separate process", async () => {
    const item = { senderId: "alice", senderSessionID: "sender", text: "@bob hello", createdAt: 100 };
    const first = queue.getOrCreatePendingAdmission("session", "room", [item], "prompt", 100, false);
    const queueUrl = new URL("./queue.ts", import.meta.url).href;
    const output = await spawnCode(`const q=await import(${JSON.stringify(queueUrl)}); const a=q.pendingAdmission("session","room"); q.markPendingAdmissionAdmitted("session","room",a.id); console.log(JSON.stringify({id:q.getOrCreatePendingAdmission("session","room",[${JSON.stringify(item)}],"prompt",100,false).id,state:q.pendingAdmission("session","room").state}));`);
    expect(JSON.parse(output)).toEqual({ id: first.id, state: "admitted" });
    expect(queue.pendingAdmission("session", "room")?.id).toBe(first.id);
    queue.clearPendingAdmission("session", "room", 100);
    expect(queue.pendingAdmission("session", "room")).toBeUndefined();
});

  test("plugin and daemon notification contenders admit one host prompt", async () => {
    const store = await import("./store");
    const roomID = `race-${crypto.randomUUID()}`;
    const sid = `session-${crypto.randomUUID()}`;
    const message = { id: "m1", roomId: roomID, senderId: "alice", senderSessionID: "other", text: "hello", createdAt: 500 };
    await store.writeState((service, registry) => {
      service.hydrate([{ id: roomID, name: "dev", ownerId: "alice", createdAt: 1, participants: new Map(), messages: [message] }]);
      registry[roomID] = { [sid]: { serverUrl: "", apiPrefix: "/api", protocol: "v2", name: "bob", lastReadTs: 0 } };
    });
    const attempts = path.join(stateHome, "prompt-attempts");
    const notifierURL = new URL("./plugin-notifications.ts", import.meta.url).href;
    const storeURL = new URL("./store.ts", import.meta.url).href;
    const queueURL = new URL("./queue.ts", import.meta.url).href;
    const childSource = `const [{createNotifier},store,q]=await Promise.all([import(${JSON.stringify(notifierURL)}),import(${JSON.stringify(storeURL)}),import(${JSON.stringify(queueURL)})]); const tr={protocol:"v2",backgroundSession:async()=>false,promptQueue:async(s,id,text,delivery)=>{await Bun.write(${JSON.stringify(attempts)},(await Bun.file(${JSON.stringify(attempts)}).text().catch(()=>""))+process.pid+"\\n");await new Promise(r=>setTimeout(r,100));return {id,sessionID:s,delivery}}}; const n=createNotifier({transport:()=>tr,bumpQueued:async(_r,_s,ts)=>{await store.writeState((_svc,reg)=>{reg[${JSON.stringify(roomID)}][${JSON.stringify(sid)}].lastQueuedTs=ts});q.clearPendingAdmission(${JSON.stringify(sid)},${JSON.stringify(roomID)},ts);return true}}); await n.notifyTarget(${JSON.stringify(sid)},{roomId:${JSON.stringify(roomID)},roomName:"dev",messages:[${JSON.stringify(message)}]},tr);`;
    const [{ createNotifier }, queue] = await Promise.all([import("./plugin-notifications"), import("./queue")]);
    const transport = { protocol: "v2" as const, backgroundSession: async () => false, promptQueue: async (sessionID: string, id: string, _text: string, delivery: "queue" | "steer") => {
      await fs.appendFile(attempts, `${process.pid}\n`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { id, sessionID, delivery };
    } };
    const notifier = createNotifier({ transport: () => transport, bumpQueued: async (_room, _session, ts) => {
      await store.writeState((_service, registry) => { registry[roomID]![sid]!.lastQueuedTs = ts; });
      queue.clearPendingAdmission(sid, roomID, ts);
      return true;
    } });
    await Promise.all([
      notifier.notifyTarget(sid, { roomId: roomID, roomName: "dev", messages: [message] }, transport),
      spawnCode(childSource),
    ]);
    expect((await fs.readFile(attempts, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await store.loadRegistry())[roomID]![sid]!.lastQueuedTs).toBe(500);
  });

  test("a real SQLite lock during heartbeat loses the lease without an unhandled error", async () => {
    const directory = path.join(stateHome, "opencode", "chat-room");
    const file = path.join(directory, "receiver.sqlite");
    const script = `const {Database}=await import("bun:sqlite"); const db=new Database(${JSON.stringify(file)}); db.exec("PRAGMA busy_timeout=50; BEGIN IMMEDIATE; UPDATE delivery_leases SET expires_at=expires_at WHERE session_id='lease-contention'"); console.log("LOCKED"); await new Promise(r=>setTimeout(r,12000)); db.exec("ROLLBACK"); db.close();`;
    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    let result: string | undefined;
    let sideEffects = 0;
    let lockChild: ReturnType<typeof Bun.spawn> | undefined;
    try {
      result = await serializeSessionPush("lease-contention", async () => {
        lockChild = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "ignore" });
        const stdoutStream = lockChild.stdout;
        if (!(stdoutStream instanceof ReadableStream)) throw new Error("child stdout pipe unavailable");
        const reader = stdoutStream.getReader();
        const decoder = new TextDecoder();
        let output = "";
        while (!output.includes("LOCKED")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SQLite lock child exited before acquiring the lock");
          output += decoder.decode(chunk.value);
        }
        await new Promise((resolve) => setTimeout(resolve, 5500));
        try { assertDeliveryLease(); sideEffects++; return "side-effect-allowed"; }
        catch { return "lease-lost"; }
      });
      expect(await lockChild?.exited).toBe(0);
    } finally { process.off("unhandledRejection", onUnhandled); }
    expect(result).toBe("lease-lost");
    expect(sideEffects).toBe(0);
    expect(unhandled).toBeUndefined();
  }, 20_000);
});

afterAll(async () => {
  closeReceiverState();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(stateHome, { recursive: true, force: true });
});
