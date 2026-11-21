// ponytail: node:http <-> web Request/Response adapter. Product code uses the
// web handler shape, so Bun (auto-serve), Node and Deno share one implementation.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ServerOptions = {
  hostname: string;
  port: number;
  fetch(request: Request): Response | Promise<Response>;
  maxRequestBodySize?: number;
  idleTimeout?: number;
};

export type StartedServer = {
  port: number;
  close(): Promise<void>;
};

const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

function requestURL(req: IncomingMessage, hostname: string, port: number): string {
  const path = req.url ?? "/";
  if (/^https?:\/\//i.test(path)) return path;
  const host = req.headers.host ?? (hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`);
  return `http://${host}${path}`;
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (!hopByHop.has(name)) headers.append(name, raw[i + 1]!);
  }
  return headers;
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// The response must reach the client before the unread request body is
// discarded, so destroy only after the 413 has been flushed to the socket.
function rejectTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
  sendJson(res, 413, "request body too large");
}

async function discardBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A locked or already-consumed body needs no cleanup. */ }
}

async function writeResponse(res: ServerResponse, response: Response, method: string): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (method === "HEAD" || response.status === 204 || response.status === 304 || !response.body) {
    await discardBody(response);
    res.end();
    return;
  }
  // pipeline destroys the web stream (and so cancels the source) when the
  // client disconnects, which is the abort propagation we need here.
  await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), res);
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  hostname: string,
  port: number,
  handler: ServerOptions["fetch"],
  maxBody: number,
): Promise<void> {
  const abort = new AbortController();
  const onAborted = () => abort.abort();
  req.once("aborted", onAborted);
  req.once("error", onAborted);
  const method = req.method ?? "GET";
  let tooLarge = false;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBody) {
      rejectTooLarge(req, res);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      let received = 0;
      body = (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBody) {
            tooLarge = true;
            controller.error(new Error("request body too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }));
    }
    const request = new Request(requestURL(req, hostname, port), {
      method,
      headers: requestHeaders(req),
      body,
      signal: abort.signal,
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
    const response = await handler(request);
    if (tooLarge) {
      await discardBody(response);
      rejectTooLarge(req, res);
      return;
    }
    await writeResponse(res, response, method);
  } catch {
    if (tooLarge) {
      rejectTooLarge(req, res);
    } else if (!abort.signal.aborted && !res.headersSent) {
      sendJson(res, 500, "internal server error");
    } else if (!res.destroyed) {
      res.destroy();
    }
  } finally {
    req.off("aborted", onAborted);
    req.off("error", onAborted);
    // A handler may answer without reading the request (for example a 401);
    // cancel the stream so the remaining body is not buffered in memory.
    if (body) void body.cancel().catch(() => {});
    else if (!req.readableEnded) req.resume();
  }
}

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const maxBody = options.maxRequestBodySize ?? Infinity;
  const server = createServer((req, res) => {
    void serve(req, res, options.hostname, options.port, options.fetch, maxBody);
  });
  // Bun's idleTimeout is socket inactivity, not a total request deadline: a
  // slow upload must not be cut by either Node timer.
  if (options.idleTimeout && options.idleTimeout > 0) server.timeout = options.idleTimeout * 1000;
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}