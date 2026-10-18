import { authHeader } from "./store";
import { admissionMatches, type QueueBody } from "./queue";

export type PushResult = "delivered" | "unreachable" | "rejected";
export type QueueTransport = {
  promptQueue?: (sessionID: string, id: string, text: string) => Promise<unknown>;
  serverUrl?: string;
  directory?: string;
  protocol?: "v1" | "v2";
};

export function createQueueTransport(input: { directory?: string; serverUrl?: URL | string } = {}): QueueTransport {
  const serverUrl = String(input.serverUrl ?? "").trim();
  return { serverUrl: serverUrl || undefined, protocol: "v1", directory: input.directory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status === "number") return value.status;
  if (isRecord(value.response) && typeof value.response.status === "number") return value.response.status;
  if (isRecord(value.cause) && typeof value.cause.status === "number") return value.cause.status;
  return undefined;
}

function headers(transport: QueueTransport): Record<string, string> {
  const auth = authHeader();
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: auth } : {}),
    ...(transport.directory ? { "x-opencode-directory": encodeURIComponent(transport.directory) } : {}),
  };
}

async function sendQueueInProcess(
  transport: QueueTransport,
  sessionID: string,
  body: QueueBody,
): Promise<PushResult> {
  let result: unknown;
  try {
    result = await transport.promptQueue!(sessionID, body.id, body.prompt.text);
  } catch (error) {
    const status = statusOf(error);
    return status === undefined || status === 404 ? "unreachable" : "rejected";
  }
  if (!isRecord(result)) return "unreachable";
  if (!isRecord(result.response)) return admissionMatches(result, body, sessionID) ? "delivered" : "rejected";
  const status = result.response.status;
  if (typeof status !== "number" || status === 404) return "unreachable";
  if (status < 200 || status >= 300) return "rejected";
  return admissionMatches(result.data, body, sessionID) ? "delivered" : "rejected";
}

async function sendQueueHttp(
  transport: QueueTransport,
  sessionID: string,
  body: QueueBody,
): Promise<PushResult> {
  if (!transport.serverUrl) return "unreachable";
  let response: Response;
  try {
    response = await fetch(`${transport.serverUrl.replace(/\/+$/, "")}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      headers: headers(transport),
      body: JSON.stringify({
        id: body.id,
        text: body.prompt.text,
        delivery: body.delivery,
        resume: body.resume,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "unreachable";
  }
  const data = await response.json().catch(() => undefined);
  if (response.status === 404) return "unreachable";
  if (!response.ok) return "rejected";
  return admissionMatches(data, body, sessionID) ? "delivered" : "rejected";
}

export async function sendAsyncNotification(
  transport: QueueTransport,
  sessionID: string,
  text: string,
): Promise<PushResult> {
  if (!transport.serverUrl) return "unreachable";
  let response: Response;
  let base: string;
  try {
    base = new URL(transport.serverUrl).origin;
  } catch {
    return "unreachable";
  }
  try {
    response = await fetch(`${base}/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      headers: headers(transport),
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "unreachable";
  }
  return response.status === 204 ? "delivered" : response.status === 404 ? "unreachable" : "rejected";
}

export async function sendQueue(
  transport: QueueTransport,
  sessionID: string,
  text: string,
  admissionID: string,
): Promise<PushResult> {
  const body: QueueBody = {
    id: admissionID,
    prompt: { text },
    delivery: "queue",
    resume: true,
  };
  if (transport.promptQueue) {
    const result = await sendQueueInProcess(transport, sessionID, body);
    if (result !== "unreachable") return result;
  }
  return sendQueueHttp(transport, sessionID, body);
}
