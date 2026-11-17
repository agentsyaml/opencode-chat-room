import http from "node:http";

export async function startCenter(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://localhost");
    const entry = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(entry);
    let status = 404;
    let payload = { error: "not found" };
    try {
      const result = await handler(entry);
      if (result) [status, payload] = result;
    } catch (error) {
      status = 500;
      payload = { error: String(error?.message ?? error) };
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function roomPayload(overrides = {}) {
  return {
    id: "r1",
    name: "dev",
    ownerId: "alex@host",
    createdAt: 1,
    kind: "group",
    participants: [{ id: "alex@host", name: "alex@host" }],
    messages: [],
    ...overrides,
  };
}