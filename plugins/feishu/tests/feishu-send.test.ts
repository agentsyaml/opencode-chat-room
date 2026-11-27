import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { deterministicUuid, sendMessage, type FeishuConfig, type TokenState } from "../src/feishu-send.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

class FakeFeishu {
  readonly requests: RecordedRequest[] = [];
  readonly #server: Server;
  #port = 0;
  #messages = 0;

  constructor() {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = request.url ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      this.requests.push({ method: request.method ?? "", url, body });
      response.setHeader("content-type", "application/json");
      if (url.startsWith("/open-apis/auth/")) {
        response.end(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }));
      } else if (url === "/open-apis/im/v1/images") {
        response.end(JSON.stringify({ code: 0, data: { image_key: "img_1" } }));
      } else if (url === "/open-apis/im/v1/files") {
        response.end(JSON.stringify({ code: 0, data: { file_key: "file_1" } }));
      } else if (url.startsWith("/open-apis/im/v1/messages")) {
        response.end(JSON.stringify({ code: 0, data: { message_id: `om_${++this.#messages}` } }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ code: 404 }));
      }
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}

const config = (baseUrl: string): FeishuConfig => ({
  appId: "cli_test", appSecret: "secret", baseUrl, timeoutMs: 5000,
  cardVersion: "2.0", inbound: false, inboundChats: new Set(),
});

const state = (): TokenState => ({ accountId: "main", tokenExpiresAt: 0 });

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function attachmentFile(name: string, bytes: number[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-send-test-"));
  cleanup = () => rm(directory, { recursive: true, force: true });
  const file = path.join(directory, name);
  await writeFile(file, Uint8Array.from(bytes), { mode: 0o600 });
  return file;
}

describe("feishu attachment sends", () => {
  test("uploads an image and sends the card before the native image message", async () => {
    const fake = new FakeFeishu();
    await fake.start();
    try {
      const file = await attachmentFile("photo.png", [0x89, 0x50, 0x4e, 0x47]);
      const receipt = await sendMessage(config(fake.baseUrl), state(), {
        idempotencyKey: "key-1",
        target: { roomId: "oc_chat" },
        payload: {
          text: "caption\n[[resource:0f8fad5b-d9cb-469f-a165-70867728950e]]",
          attachments: [{ kind: "image", name: "photo.png", mimeType: "image/png", size: 4, path: file }],
        },
      });

      expect(receipt.state).toBe("sent");
      const messages = fake.requests.filter((request) => request.url.startsWith("/open-apis/im/v1/messages"));
      expect(messages).toHaveLength(2);
      const card = JSON.parse(messages[0]!.body) as { msg_type: string; content: string; uuid: string };
      expect(card.msg_type).toBe("interactive");
      expect(card.content).toContain("caption");
      expect(card.content).not.toContain("[[resource:");
      expect(card.uuid).toBe(deterministicUuid("key-1:text"));
      const image = JSON.parse(messages[1]!.body) as { msg_type: string; content: string; uuid: string };
      expect(image.msg_type).toBe("image");
      expect(JSON.parse(image.content)).toEqual({ image_key: "img_1" });
      expect(image.uuid).toBe(deterministicUuid("key-1:attachment:0"));
      const upload = fake.requests.find((request) => request.url === "/open-apis/im/v1/images")!;
      expect(upload.body).toContain('name="image_type"');
      expect(upload.body).toContain("message");
      expect(upload.body).toContain("photo.png");
    } finally {
      await fake.close();
    }
  });

  test("uploads a file and sends a native file message without a card when the text is only a marker", async () => {
    const fake = new FakeFeishu();
    await fake.start();
    try {
      const file = await attachmentFile("report.pdf", [0x25, 0x50, 0x44, 0x46]);
      const receipt = await sendMessage(config(fake.baseUrl), state(), {
        idempotencyKey: "key-2",
        target: { room: "oc_chat" },
        payload: {
          text: "[[resource:0f8fad5b-d9cb-469f-a165-70867728950e]]",
          attachments: [{ kind: "file", name: "report.pdf", mimeType: "application/pdf", size: 4, path: file }],
        },
      });

      expect(receipt.state).toBe("sent");
      const messages = fake.requests.filter((request) => request.url.startsWith("/open-apis/im/v1/messages"));
      expect(messages).toHaveLength(1);
      const fileMessage = JSON.parse(messages[0]!.body) as { msg_type: string; content: string };
      expect(fileMessage.msg_type).toBe("file");
      expect(JSON.parse(fileMessage.content)).toEqual({ file_key: "file_1" });
      const upload = fake.requests.find((request) => request.url === "/open-apis/im/v1/files")!;
      expect(upload.body).toContain('name="file_type"');
      expect(upload.body).toContain("stream");
      expect(upload.body).toContain("report.pdf");
    } finally {
      await fake.close();
    }
  });

  test("a missing attachment file is a permanent failure with a clear reason", async () => {
    const fake = new FakeFeishu();
    await fake.start();
    try {
      const receipt = await sendMessage(config(fake.baseUrl), state(), {
        idempotencyKey: "key-3",
        target: { roomId: "oc_chat" },
        payload: {
          text: "caption",
          attachments: [{ kind: "image", name: "gone.png", path: "/nonexistent/gone.png" }],
        },
      });
      expect(receipt.state).toBe("permanent");
      expect(receipt.detail).toContain("gone.png");
    } finally {
      await fake.close();
    }
  });
});