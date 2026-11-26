// Inbox long-poll, queue acknowledgements and wake arbitration.
import { acknowledgeQueued } from "../../src/state/store.ts";
import { clearPendingAdmission } from "../../src/center/queue.ts";
import { readInbox } from "../inbox.ts";
import { jsonObject } from "../json-body.ts";
import { claimWake, touchActive } from "../wake.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function inboxRoutes(req: Request, url: URL): Promise<Response | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/inbox") {
    const sessionID = url.searchParams.get("sessionID") ?? "";
    const roomFilter = url.searchParams.get("roomId");
    const afterValue = url.searchParams.get("afterTs");
    const afterTs = afterValue === null ? undefined : Number(afterValue);
    const recallVersionValue = url.searchParams.get("recallVersion");
    if (url.searchParams.has("recallVersion") && (recallVersionValue === "" || !/^\d+$/.test(recallVersionValue ?? "") ||
      !Number.isSafeInteger(Number(recallVersionValue)))) {
      return json({ error: "recallVersion must be a non-negative safe integer" }, 400);
    }
    const clientRecallVersion = recallVersionValue === null ? undefined : Number(recallVersionValue);
    if (url.searchParams.has("afterTs") && (afterValue === "" || !/^\d+$/.test(afterValue ?? "") ||
      !Number.isSafeInteger(afterTs) || afterTs! < 0 || !roomFilter || url.searchParams.get("excludeSelf") !== "0")) {
      return json({ error: "afterTs requires a roomId and excludeSelf=0, with a non-negative safe integer value" }, 400);
    }
    // ponytail: poll includes the caller's own messages (echo), the
    // notification self-pull excludes them — aligned with standalone poll
    const excludeSelf = url.searchParams.get("excludeSelf") === "1";
    // long-poll: wait up to `timeout` ms for the first new message
    // instead of returning empty immediately (web chat + sub-agent
    // watchers); empty responses only happen on timeout
    const timeout = Math.min(
      Math.max(Number(url.searchParams.get("timeout") ?? 0) || 0, 0),
      30000,
    );
    const deadline = Date.now() + timeout;
    let result = await readInbox(sessionID, roomFilter, excludeSelf, afterTs);
    // The client's rendered snapshot version is the baseline; using the first
    // read instead would hide a recall that landed before this request started.
    const initialRecallVersion = clientRecallVersion ?? result.recallVersion;
    // A recall bumps the version without creating a message; wake the poll so
    // the client can refetch the room snapshot (reliable version compare).
    while (result.items.length === 0 && result.recallVersion === initialRecallVersion && Date.now() < deadline) {
      // ponytail: 500ms between disk scans keeps notification latency under
      // half a second; a longer interval makes deliveries feel stuck.
      await sleep(Math.max(1, Math.min(500, deadline - Date.now())));
      result = await readInbox(sessionID, roomFilter, excludeSelf, afterTs);
    }
    return json(result);
  }
  if (req.method === "POST" && p === "/queued") {
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const ts = Number(body.ts);
    const roomId = String(body.roomId ?? "");
    const sessionID = String(body.sessionID ?? "");
    if (
      body.ts === undefined ||
      body.ts === null ||
      !roomId ||
      !sessionID ||
      !Number.isFinite(ts)
    ) {
      return json({ error: "roomId/sessionID/finite ts are required" }, 400);
    }
    // Clamp to the room tail so a forged future ts cannot silence delivery.
    const updated = await acknowledgeQueued(roomId, sessionID, ts);
    if (updated === null) {
      return json({ error: "registry entry not found" }, 404);
    }
    clearPendingAdmission(sessionID, roomId, updated);
    touchActive(sessionID);
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/active") {
    // Active report: the plugin calls this for sessions it successfully pushed
    // in-process (genuinely active), so the server avoids a duplicate serve wake.
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    touchActive(String(body.sessionID ?? ""));
    return json({ ok: true });
  }
  if (req.method === "POST" && p === "/wake-claim") {
    // ponytail: atomic cross-process wake dedupe (see claimWake) — the
    // server only arbitrates, it never spawns anything itself
    const body = await jsonObject<Record<string, unknown>>(req);
    if (!body) return json({ error: "JSON object body is required" }, 400);
    const sessionID = String(body.sessionID ?? "");
    const ok = claimWake(sessionID);
    return json({ ok });
  }
  return undefined;
}