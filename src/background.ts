export async function backgroundOwnSession(sessionID: string, version: string): Promise<boolean> {
  try {
    const [{ OpenCode }, { Service }] = await Promise.all([
      import("@opencode/client"), import("@opencode/client/service"),
    ]);
    return backgroundAtRegisteredService(sessionID, version, {
      discover: () => Service.discover({ version }),
      headers: Service.headers,
      createClient: (baseUrl, headers) => OpenCode.make({ baseUrl, headers }),
    });
  } catch {
    return false;
  }
}

type BackgroundApi = {
  discover(): Promise<{ url: string; auth?: { type: "basic"; username: string; password: string } } | undefined>;
  headers(endpoint: { url: string; auth?: { type: "basic"; username: string; password: string } }): Record<string, string> | undefined;
  createClient(baseUrl: string, headers?: Record<string, string>): {
    server: { info(options: { signal: AbortSignal }): Promise<{ pid: number; version: string }> };
    session: { background(input: { sessionID: string }, options: { signal: AbortSignal }): Promise<void> };
  };
};

export async function backgroundAtRegisteredService(
  sessionID: string,
  version: string,
  api: BackgroundApi,
  pid = process.pid,
): Promise<boolean> {
  try {
    let timer: ReturnType<typeof setTimeout>;
    const endpoint = await Promise.race([
      api.discover(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
    ]).finally(() => clearTimeout(timer!));
    if (!endpoint) return false;
    const url = new URL(endpoint.url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return false;
    const headers = api.headers(endpoint);
    const client = api.createClient(url.origin, headers);
    const info = await client.server.info({ signal: AbortSignal.timeout(1500) });
    if (info.pid !== pid || info.version !== version) return false;
    await client.session.background({ sessionID }, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
