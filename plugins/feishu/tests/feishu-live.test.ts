import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FeishuLiveConnection, type LiveSocket } from "../src/feishu-live.ts";
import { decodeFrame, headerValue } from "../src/feishu-ws-frames.ts";

class FakeSocket implements LiveSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly #listeners = new Map<string, Array<(event: any) => void>>();

  constructor() {
    setTimeout(() => this.open(), 0);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.#emit("close", {});
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.#emit("open", {});
  }

  closeFromServer(): void {
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

const servers: Server[] = [];
const liveConnections: FeishuLiveConnection[] = [];

afterEach(async () => {
  for (const live of liveConnections.splice(0)) await live.stop();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

async function discoveryServer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        URL: "ws://fake/ws/v2?service_id=3&device_id=test",
        ClientConfig: { PingInterval: 0.01, ReconnectCount: -1, ReconnectInterval: 0.01, ReconnectNonce: 0.001 },
      },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("feishu live connection", () => {
  test("a late close from a replaced socket does not steal the new connection", async () => {
    const baseUrl = await discoveryServer();
    const sockets: FakeSocket[] = [];
    const logs: string[] = [];
    const live = new FeishuLiveConnection({
      appId: "cli_test",
      appSecret: "secret_test",
      baseUrl,
      timeoutMs: 2000,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onEvent: async () => true,
      log: (message) => logs.push(message),
    });
    liveConnections.push(live);
    await live.start();
    expect(sockets).toHaveLength(1);

    sockets[0]!.closeFromServer();
    await Bun.sleep(80);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const current = sockets.at(-1)!;
    expect(current.readyState).toBe(1);

    // The old socket's close listener must be inert after the reconnect.
    sockets[0]!.closeFromServer();
    await Bun.sleep(80);
    expect(sockets).toHaveLength(2);
    expect(current.readyState).toBe(1);

    const pings = current.sent
      .map((bytes) => decodeFrame(bytes))
      .filter((frame) => headerValue(frame, "type") === "ping");
    expect(pings.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("reconnected"))).toBe(true);
  });
});