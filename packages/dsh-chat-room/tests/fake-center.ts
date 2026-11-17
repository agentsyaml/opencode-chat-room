export interface CapturedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization: string;
}

export type FakeReply = [status: number, body: unknown] | undefined;

/** A local stand-in for the central chat-room HTTP API. */
export function startFakeCenter(handler: (request: CapturedRequest) => FakeReply) {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const raw = await request.text();
      const entry: CapturedRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body: raw ? JSON.parse(raw) as unknown : undefined,
        authorization: request.headers.get("authorization") ?? "",
      };
      requests.push(entry);
      const [status, body] = handler(entry) ?? [404, { error: "not found" }];
      return Response.json(body, { status });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}