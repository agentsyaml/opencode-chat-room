import { describe, expect, test } from "bun:test";
import { createFrameReader, parseFrame } from "../src/framing.ts";
import { MAX_FRAME_BYTES } from "../src/protocol.ts";

function harness() {
  const messages: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  const feed = createFrameReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  return { messages, errors, feed };
}

describe("newline-delimited JSON framing", () => {
  test("reassembles a frame split inside a multi-byte UTF-8 character", () => {
    const { messages, errors, feed } = harness();
    const frame = Buffer.from(`${JSON.stringify({ text: "café 🙂", n: 1 })}\n`);
    const inside = frame.indexOf(Buffer.from("🙂")) + 1;
    feed(frame.subarray(0, inside));
    feed(frame.subarray(inside, inside + 2));
    feed(frame.subarray(inside + 2));
    expect(errors).toEqual([]);
    expect(messages).toEqual([{ text: "café 🙂", n: 1 }]);
  });

  test("reads two frames from one chunk", () => {
    const { messages, errors, feed } = harness();
    feed(Buffer.from(`${JSON.stringify({ a: 1 })}\n${JSON.stringify({ b: 2 })}\n`));
    expect(errors).toEqual([]);
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("rejects an oversize frame without emitting a partial message", () => {
    const { messages, errors, feed } = harness();
    const oversized = `{"x":"${"a".repeat(MAX_FRAME_BYTES)}"}`;
    feed(Buffer.from(`${oversized}\n${JSON.stringify({ after: true })}\n`));
    expect(messages).toEqual([{ after: true }]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("MAX_FRAME_BYTES");
  });

  test("reports non-object frames", () => {
    expect(() => parseFrame("[1,2]")).toThrow("frame must be a JSON object");
    expect(() => parseFrame("not json")).toThrow("invalid JSON frame");
  });
});