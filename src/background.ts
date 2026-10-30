import { receiverOwnerID } from "./receiver-owner";
import { assertDeliveryLease } from "./session-delivery";
import type { BackgroundResult } from "./queue-transport";

type BackgroundHost = NonNullable<Awaited<ReturnType<typeof discoverVerifiedHost>>> & { pid: number; version: string };
type HostLookup = { host?: BackgroundHost; result?: BackgroundResult };
const failed = (reason: string): BackgroundResult => ({ status: "failed", reason });
const skip = (reason: string): BackgroundResult => ({ status: "skip", reason });

function outcome(error: unknown): BackgroundResult {
  const value = error as { name?: string; code?: string; status?: number; response?: { status?: number }; cause?: { code?: string; status?: number } };
  const status = value?.status ?? value?.response?.status ?? value?.cause?.status;
  const code = value?.code ?? value?.cause?.code;
  if (status === 404) return skip("unsupported-or-session-missing");
  if (status === 400 || status === 401 || status === 403) return skip("request-rejected");
  if (value?.name === "TimeoutError" || code === "ETIMEDOUT" || code === "ABORT_ERR") return failed("timeout");
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return failed("connection-failed");
  if (typeof status === "number" && status >= 500) return failed("server-error");
  return status ? skip("request-rejected") : failed("request-unavailable");
}

async function backgroundHost(version: string, compatible: boolean): Promise<HostLookup> {
  try {
    const [{ OpenCode }, { Service }] = await Promise.all([
      import("@opencode/client"), import("@opencode/client/service"),
    ]);
    const discover = () => Service.discover({ version: compatible ? (value: string) => /^2\./.test(value) : version });
    let timer: ReturnType<typeof setTimeout>;
    const endpoint = await Promise.race([
      discover(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
    ]).finally(() => clearTimeout(timer!));
    if (!endpoint) return { result: failed("service-not-registered") };
    const url = new URL(endpoint.url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return { result: skip("non-loopback-registration") };
    const client = OpenCode.make({ baseUrl: url.origin, headers: Service.headers(endpoint) });
    const info = await client.server.info({ signal: AbortSignal.timeout(3000) });
    if (!Number.isInteger(info.pid) || !/^2\./.test(info.version)) return { result: skip("invalid-host-identity") };
    if (!compatible && info.version !== version) return { result: skip("version-mismatch") };
    if (!compatible && info.pid !== process.pid) return { result: skip("process-mismatch") };
    if (compatible) {
      const current = await discover();
      if (!current || new URL(current.url).origin !== url.origin) return { result: skip("registered-service-changed") };
      const verified = await OpenCode.make({ baseUrl: url.origin, headers: Service.headers(current) })
        .server.info({ signal: AbortSignal.timeout(3000) });
      if (verified.pid !== info.pid || verified.version !== info.version) return { result: skip("registered-service-changed") };
      return { host: { origin: url.origin, pid: verified.pid, version: verified.version, client: OpenCode.make({ baseUrl: url.origin, headers: Service.headers(current) }) } };
    }
    return { host: { origin: url.origin, pid: info.pid, version: info.version, client } };
  } catch (error) { return { result: outcome(error) }; }
}

async function background(host: BackgroundHost, sessionID: string): Promise<BackgroundResult> {
  try {
    assertDeliveryLease();
    await host.client.session.background({ sessionID }, { signal: AbortSignal.timeout(8000) });
    return { status: "done" };
  } catch (error) { return outcome(error); }
}

export async function backgroundOwnSession(sessionID: string, version: string): Promise<BackgroundResult> {
  const lookup = await backgroundHost(version, false);
  return lookup.host ? background(lookup.host, sessionID) : lookup.result!;
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
): Promise<BackgroundResult> {
  const lookup = await backgroundHost("", true);
  if (!lookup.host) return lookup.result!;
  const host = lookup.host;
  if (host.origin !== expected.origin || host.pid !== expected.pid || host.version !== expected.version) return skip("registered-service-changed");
  return background(host, sessionID);
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
): Promise<BackgroundResult> {
  try {
    let timer: ReturnType<typeof setTimeout>;
    const endpoint = await Promise.race([
      api.discover(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
    ]).finally(() => clearTimeout(timer!));
    if (!endpoint) return failed("service-not-registered");
    const url = new URL(endpoint.url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return skip("non-loopback-registration");
    const headers = api.headers(endpoint);
    const client = api.createClient(url.origin, headers);
    const info = await client.server.info({ signal: AbortSignal.timeout(1500) });
    if (info.pid !== pid || info.version !== version) return skip(info.pid !== pid ? "process-mismatch" : "version-mismatch");
    await client.session.background({ sessionID }, { signal: AbortSignal.timeout(8000) });
    return { status: "done" };
  } catch (error) { return outcome(error); }
}
