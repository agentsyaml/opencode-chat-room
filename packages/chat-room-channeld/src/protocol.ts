export const PROTOCOL_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;

export type Endpoint = { platform: string; accountId: string; roomId: string };

export type MessageRef = {
  endpoint: Endpoint;
  nativeMessageId: string;
  /** Optional preview text supplied by the adapter for quote transforms. */
  text?: string;
};

export type ActorKey = { platform: string; identityNamespace: string; nativeUserId: string };

/**
 * One attachment carried by an event. Outbound chatroom forwards name a
 * `resourceId` the host resolves at send time; inbound adapter events supply a
 * local `path` the host imports into the room.
 */
export type AttachmentRef = {
  kind: "image" | "file";
  name: string;
  mimeType?: string;
  size?: number;
  resourceId?: string;
  roomId?: string;
  path?: string;
  sourceId?: string;
  error?: string;
};

export type AttachmentCapabilities = {
  kinds: Array<"image" | "file">;
  imageMaxBytes?: number;
  fileMaxBytes?: number;
};

/**
 * One account setting declared by an adapter. `key` is the env variable the
 * adapter process reads; the UI renders the field and stores its value there.
 */
export type AccountField = {
  key: string;
  label?: string;
  type?: "string" | "secret" | "boolean" | "number" | "select";
  required?: boolean;
  default?: string;
  description?: string;
  options?: Array<{ value: string; label?: string }>;
};

export type AccountCapabilities = {
  /** Primary form fields, in display order. */
  schema?: AccountField[];
  /** Advanced env declarations; keys not covered here stay free-form. */
  env?: AccountField[];
};

/** Adapter-declared platform facts the generic host must not hardcode. */
export type AdapterCapabilities = {
  displayName?: string;
  attachments?: AttachmentCapabilities;
  account?: AccountCapabilities;
};

export interface IngestEvent {
  schemaVersion: number;
  eventId: string;
  kind: string;
  source: Endpoint;
  actor: ActorKey;
  providerEventId?: string;
  sourceDedupKey: string;
  message?: MessageRef;
  parent?: MessageRef;
  occurredAt?: string;
  receivedAt: string;
  content?: { text?: string; attachmentRefs?: string[]; attachments?: AttachmentRef[] };
  selectedMessage?: MessageRef;
  requestedTarget?: Endpoint;
  cause?: { rootEventId: string; visitedEndpoints: Endpoint[]; hopCount: number };
  ingressSeq?: number;
}

export type JsonRpcId = string | number;

export type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };
export type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };
export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};
export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure;

export const HOST_ID_PREFIX = "host-";
export const ADAPTER_ID_PREFIX = "adapter-";

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

export function hostRequestId(sequence: number): string {
  return `${HOST_ID_PREFIX}${sequence}`;
}

export function adapterRequestId(sequence: number): string {
  return `${ADAPTER_ID_PREFIX}${sequence}`;
}

export function rpcRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}