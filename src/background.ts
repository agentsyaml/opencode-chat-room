import { receiverOwnerID } from "./receiver-owner";
import { assertDeliveryLease } from "./session-delivery";

export async function backgroundOwnSession(sessionID: string, version: string): Promise<boolean> {
  try {
    const host = await discoverVerifiedHost(version);
    if (!host) return false;
    assertDeliveryLease();
    await host.client.session.background({ sessionID }, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export async function discoverVerifiedHost(version: string) {
  const [{ OpenCode }, { Service }] = await Promise.all([
    import("@opencode/client"), import("@opencode/client/service"),
  ]);
  let timer: ReturnType<typeof setTimeout>;
  const endpoint = await Promise.race([
    Service.discover({ version }),
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
  ]).finally(() => clearTimeout(timer!));
  if (!endpoint) return undefined;
  const url = new URL(endpoint.url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return undefined;
  const client = OpenCode.make({ baseUrl: url.origin, headers: Service.headers(endpoint) });
  const info = await client.server.info({ signal: AbortSignal.timeout(1500) });
  if (info.pid !== process.pid || info.version !== version) return undefined;
  return { origin: url.origin, client };
}

export async function discoverCompatibleRegisteredHost() {
  const [{ OpenCode }, { Service }] = await Promise.all([
    import("@opencode/client"), import("@opencode/client/service"),
  ]);
  const endpoint = await Service.discover({ version: (value) => /^2\./.test(value) });
  if (!endpoint) return undefined;
  const url = new URL(endpoint.url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return undefined;
  const client = OpenCode.make({ baseUrl: url.origin, headers: Service.headers(endpoint) });
  const info = await client.server.info({ signal: AbortSignal.timeout(1500) });
  if (!Number.isInteger(info.pid) || !/^2\./.test(info.version)) return undefined;
  const current = await Service.discover({ version: (value) => /^2\./.test(value) });
  if (!current || new URL(current.url).origin !== url.origin) return undefined;
  const currentClient = OpenCode.make({ baseUrl: url.origin, headers: Service.headers(current) });
  const verified = await currentClient.server.info({ signal: AbortSignal.timeout(1500) });
  if (verified.pid !== info.pid || verified.version !== info.version) return undefined;
  return { origin: url.origin, pid: verified.pid, version: verified.version, client: currentClient };
}

export async function backgroundAtCompatibleRegisteredHost(
  sessionID: string,
  expected: { origin: string; pid: number; version: string },
): Promise<boolean> {
  try {
    const host = await discoverCompatibleRegisteredHost();
    if (!host || host.origin !== expected.origin || host.pid !== expected.pid || host.version !== expected.version) return false;
    assertDeliveryLease();
    await host.client.session.background({ sessionID }, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch { return false; }
}

export async function verifyHostSession(sessionID: string, version: string): Promise<string | undefined> {
  try {
    const host = await discoverVerifiedHost(version);
    if (!host) return undefined;
    await host.client.session.get({ sessionID }, { signal: AbortSignal.timeout(1500) });
    return receiverOwnerID(host.origin);
  } catch { return undefined; }
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
