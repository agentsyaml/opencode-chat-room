import { StringDecoder } from "node:string_decoder";
import { MAX_FRAME_BYTES } from "./protocol.ts";

export type FrameMessage = Record<string, unknown>;

/**
 * Parse one newline-delimited JSON frame. Frames must be JSON objects; a
 * scalar or array is a protocol violation.
 */
export function parseFrame(line: string): FrameMessage {
  const text = line.trim();
  if (!text) throw new Error("empty frame");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON frame: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frame must be a JSON object");
  }
  return value as FrameMessage;
}

/**
 * Feed Buffer chunks into the returned function. Complete lines are handed to
 * onMessage; parse failures and oversize frames go to onError. An oversize
 * frame is dropped up to its newline and never partially emitted.
 *
 * Byte length is checked on the raw chunk segments, before UTF-8 decoding, so
 * a frame of multi-byte characters is measured in bytes rather than UTF-16
 * code units.
 */
export function createFrameReader(
  onMessage: (message: FrameMessage) => void,
  onError: (error: Error) => void,
): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let bytes = 0;
  let discarding = false;

  const dispatch = (): void => {
    const text = discarding ? "" : parts.join("");
    const wasDiscarding = discarding;
    parts = [];
    bytes = 0;
    discarding = false;
    if (wasDiscarding || !text.trim()) return;
    try {
      onMessage(parseFrame(text));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const consume = (segment: Buffer): void => {
    const decoded = decoder.write(segment);
    if (discarding) return;
    if (bytes + segment.length > MAX_FRAME_BYTES) {
      parts = [];
      bytes = 0;
      discarding = true;
      onError(new Error(`frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES} bytes)`));
      return;
    }
    bytes += segment.length;
    parts.push(decoded);
  };

  return (chunk: Buffer): void => {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      consume(chunk.subarray(start, end));
      if (newline === -1) return;
      dispatch();
      start = newline + 1;
    }
  };
}

export class AdapterGoneError extends Error {
  readonly code = "ADAPTER_GONE";

  constructor(message: string) {
    super(message);
    this.name = "AdapterGoneError";
  }
}

const GONE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

function writeError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code && GONE_CODES.has(code)) return new AdapterGoneError(`adapter stream is gone (${code})`);
  return error instanceof Error ? error : new Error(String(error));
}

/** Write one JSON line. Protocol streams only carry JSON objects. */
export function writeFrame(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("frame must be a JSON object");
  }
  const writable = stream as NodeJS.WritableStream & {
    destroyed?: boolean;
    writableEnded?: boolean;
  };
  if (writable.destroyed || writable.writableEnded) {
    throw new AdapterGoneError("adapter stream is closed");
  }
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new RangeError(`frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES} bytes)`);
  }
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => reject(writeError(error));
    try {
      stream.write(line, (error?: Error | null) => {
        if (error) fail(error);
        else resolve();
      });
    } catch (error) {
      fail(error);
    }
  });
}