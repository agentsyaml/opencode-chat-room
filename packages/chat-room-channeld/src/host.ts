import type { AccountConfig, ChannelConfig, RuleTarget } from "./config.ts";
import { AdapterProcess, type SendReceipt } from "./adapter.ts";
import { applyReceipt, notifyDeliveryResult, type DeliveryResultHandler } from "./delivery.ts";
import { parseTarget, startFailureReason, toEndpoint, validateTargets } from "./host-helpers.ts";
import { IngestGate, type IngestResult } from "./ingest-gate.ts";
import { log } from "./log.ts";
import type { Endpoint, IngestEvent } from "./protocol.ts";
import { matchRules, planPayload, sameEndpoint, targetKey } from "./rules.ts";
import { openState, type ChannelState, type DeliveryRow } from "./state.ts";

export type { IngestResult } from "./ingest-gate.ts";

export interface AdapterHandle {
  start(): Promise<void>;
  send(
    deliveryId: string,
    attemptId: string,
    idempotencyKey: string,
    target: Endpoint,
    payload: unknown,
  ): Promise<SendReceipt>;
  stop(): Promise<void>;
}

export interface SpawnAdapterContext {
  onIngest(event: IngestEvent): Promise<{ duplicate: boolean; eventId?: string }>;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onUnavailable(reason: string): void;
}

export type SpawnAdapter = (account: AccountConfig, context: SpawnAdapterContext) => AdapterHandle;

export interface HostDeps {
  stateFactory?: (path: string) => ChannelState;
  spawnAdapter?: SpawnAdapter;
  now?: () => number;
  deliveryIntervalMs?: number;
  onDeliveryResult?: DeliveryResultHandler;
}

function defaultSpawnAdapter(account: AccountConfig, context: SpawnAdapterContext): AdapterHandle {
  return new AdapterProcess({ account, ...context });
}

export class ChannelHost {
  readonly #config: ChannelConfig;
  readonly #stateFactory: (path: string) => ChannelState;
  readonly #spawnAdapter: SpawnAdapter;
  readonly #now: () => number;
  readonly #deliveryIntervalMs: number;
  readonly #onDeliveryResult?: DeliveryResultHandler;
  readonly #adapters = new Map<string, AdapterHandle>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, Set<string>>();
  readonly #notified = new Set<string>();
  readonly #active = new Set<Promise<void>>();
  readonly #disabled = new Set<string>();
  readonly #gate = new IngestGate((accountId, _event, _error) => {
    this.#disableAccount(accountId, "ingest barrier limit reached");
  });
  #state?: ChannelState;
  #running = false;
  #starting = false;
  #idleTimer?: ReturnType<typeof setInterval>;
  #rejectionHandler?: (reason: unknown) => void;

  constructor(config: ChannelConfig, deps: HostDeps = {}) {
    this.#config = config;
    this.#stateFactory = deps.stateFactory ?? openState;
    this.#spawnAdapter = deps.spawnAdapter ?? defaultSpawnAdapter;
    this.#now = deps.now ?? Date.now;
    this.#deliveryIntervalMs = deps.deliveryIntervalMs ?? 200;
    this.#onDeliveryResult = deps.onDeliveryResult;
  }

  /** Account ids whose adapter failed to start or exited; their queues stay paused. */
  get disabledAccounts(): readonly string[] {
    return [...this.#disabled];
  }

  /** Read-only view for routes: unknown ids or platform mismatches are missing. */
  targetStatus(platform: string, accountId: string): "ready" | "disabled" | "missing" {
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (!account || account.platform !== platform) return "missing";
    return this.#disabled.has(accountId) ? "disabled" : "ready";
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error("host is already running");
    validateTargets(this.#config);
    const state = this.#stateFactory(this.#config.stateFile);
    this.#state = state;
    this.#installRejectionGuard();
    const configuredKeys = this.#config.accounts.map((account) => `${account.platform}/${account.id}`);
    const abandoned = state.abandonUnconfiguredDeliveries(configuredKeys);
    if (abandoned.length > 0) {
      log.warn(`abandoned ${abandoned.length} deliveries for unconfigured accounts`);
      for (const row of abandoned) {
        notifyDeliveryResult(state, row.deliveryId, this.#onDeliveryResult, { notified: this.#notified });
      }
    }
    const resumed = state.resumePausedDeliveries();
    if (resumed > 0) log.info(`resumed ${resumed} paused deliveries`);
    const recovered = state.recoverInFlightDeliveries();
    if (recovered > 0) log.warn(`recovered ${recovered} stale in-flight deliveries`);

    this.#running = true;
    this.#starting = true;
    const started: string[] = [];
    const failures: { id: string; reason: string }[] = [];
    const tasks = this.#config.accounts.map(async (account) => {
      let adapter: AdapterHandle | undefined;
      try {
        adapter = this.#spawnAdapter(account, {
          onIngest: (event) => this.ingest(event),
          onExit: (code, signal) => this.#handleExit(account.id, code, signal),
          onUnavailable: (reason) => this.#disableAccount(account.id, reason),
        });
        this.#adapters.set(account.id, adapter);
        await adapter.start();
        this.#schedule(account.id);
        return { id: account.id };
      } catch (error) {
        const reason = startFailureReason(account.id, error);
        this.#disabled.add(account.id);
        log.error(`adapter ${account.id} failed to start: ${reason}`, { account: account.id });
        if (adapter) {
          try {
            await adapter.stop();
          } catch {
            // The account is already marked disabled.
          }
        }
        return { id: account.id, reason };
      }
    });

    const settled = await Promise.allSettled(tasks);
    this.#starting = false;
    settled.forEach((result, index) => {
      const account = this.#config.accounts[index]!;
      if (result.status === "fulfilled") {
        const { id, reason } = result.value;
        if (reason) failures.push({ id, reason });
        else started.push(id);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ id: account.id, reason });
        this.#disabled.add(account.id);
        log.error(`adapter ${account.id} failed to start: ${reason}`, { account: account.id });
      }
    });

    for (const account of this.#config.accounts) {
      if (this.#disabled.has(account.id)) {
        state.pauseAccountDeliveries(`${account.platform}/${account.id}`, "account disabled until restart");
      }
    }

    const usable = started.filter((accountId) => !this.#disabled.has(accountId));
    if (usable.length === 0) {
      this.#running = false;
      this.#starting = false;
      this.#clearIdle();
      this.#removeRejectionGuard();
      for (const timer of this.#timers.values()) clearTimeout(timer);
      this.#timers.clear();
      await this.#stopAdapters();
      state.close();
      this.#state = undefined;
      this.#disabled.clear();
      const detail = failures.map((failure) => `${failure.id}: ${failure.reason}`).join("; ");
      throw new Error(`no adapters started${detail ? `: ${detail}` : ""}`);
    }

    for (const failure of failures) {
      log.warn(`account ${failure.id} disabled until restart; queued deliveries paused`, {
        account: failure.id,
      });
    }
    log.info(
      `host started: ${usable.length} accounts, ${failures.length} disabled, ${this.#config.rules.length} rules`,
    );
  }

  async ingest(event: IngestEvent): Promise<IngestResult> {
    return this.#gate.run(event.source.accountId, event, (item) => this.#processIngest(item));
  }

  async #processIngest(event: IngestEvent): Promise<IngestResult> {
    const state = this.#state;
    if (!state) throw new Error("host is not running");

    if (event.message) {
      const endpoint = targetKey(event.message.endpoint);
      if (state.findEcho(endpoint, event.message.nativeMessageId)) {
        log.info("echo ingest skipped", { event: event.eventId });
        return { duplicate: false, eventId: event.eventId };
      }
    }

    const result = state.commitIngest(event);
    if (result.duplicate) {
      log.info("duplicate ingest skipped", { event: result.existingEventId });
      return { duplicate: true, eventId: result.existingEventId };
    }
    const stored: IngestEvent = { ...event, ingressSeq: result.ingressSeq };
    log.info(`ingested ${stored.kind}`, { event: stored.eventId });

    if (stored.kind === "message.forward_requested") {
      const selected = stored.selectedMessage;
      const reason = !selected
        ? "selectedMessage is required"
        : !sameEndpoint(selected.endpoint, stored.source)
          ? "selectedMessage is outside the source room"
          : undefined;
      if (reason) {
        log.warn(`forward rejected: ${reason}`, { event: stored.eventId });
        return { duplicate: false, eventId: stored.eventId };
      }
    }

    const requestedTarget = stored.kind === "message.forward_requested" ? stored.requestedTarget : undefined;
    for (const rule of matchRules(this.#config, stored)) {
      const targets: RuleTarget[] = [];
      const payloads: string[] = [];
      for (const target of rule.to) {
        const endpoint = toEndpoint(this.#config, rule.id, target);
        if (requestedTarget && !sameEndpoint(endpoint, requestedTarget)) continue;
        const plan = planPayload(rule, stored, endpoint);
        if ("dropped" in plan) {
          log.warn(
            `rule ${rule.id}@${rule.version} dropped delivery to ${targetKey(endpoint)}: ${plan.dropped}`,
            { event: stored.eventId },
          );
          continue;
        }
        targets.push(target);
        payloads.push(JSON.stringify(plan.payload));
      }
      if (targets.length === 0) continue;
      const created = state.enqueueDeliveries(stored.eventId, rule, targets, payloads);
      for (const delivery of created) {
        const endpoint = parseTarget(delivery.target);
        if (endpoint && this.#disabled.has(endpoint.accountId)) {
          state.markDelivery(delivery.deliveryId, "paused", {
            lastError: "account disabled until restart",
          });
        }
        log.info(`delivery enqueued rule=${rule.id}@${rule.version}`, {
          delivery: delivery.deliveryId,
          event: stored.eventId,
        });
      }
    }
    return { duplicate: false, eventId: stored.eventId };
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#state) {
      this.#clearIdle();
      this.#removeRejectionGuard();
      return;
    }
    this.#running = false;
    this.#starting = false;
    this.#clearIdle();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#active]);
    await this.#stopAdapters();
    this.#state?.close();
    this.#state = undefined;
    this.#adapters.clear();
    this.#inFlight.clear();
    this.#notified.clear();
    this.#disabled.clear();
    this.#removeRejectionGuard();
    log.info("host stopped");
  }

  #schedule(accountId: string): void {
    if (!this.#running || this.#disabled.has(accountId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(accountId);
      if (!this.#running) return;
      const task = this.#drainOnce(accountId)
        .catch((error: unknown) => {
          log.error(`delivery loop failed: ${error instanceof Error ? error.message : String(error)}`, {
            account: accountId,
          });
        })
        .finally(() => {
          this.#active.delete(task);
          this.#schedule(accountId);
        });
      this.#active.add(task);
    }, this.#deliveryIntervalMs);
    this.#timers.set(accountId, timer);
  }

  async #drainOnce(accountId: string): Promise<void> {
    if (!this.#running || this.#disabled.has(accountId)) return;
    const state = this.#state;
    const adapter = this.#adapters.get(accountId);
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (!state || !adapter || !account) return;
    const accountKey = `${account.platform}/${account.id}`;
    const row = state.nextPendingDelivery(accountKey, this.#now());
    if (!row) return;
    await this.#deliver(state, adapter, accountId, row);
  }

  async #deliver(
    state: ChannelState,
    adapter: AdapterHandle,
    accountId: string,
    row: DeliveryRow,
  ): Promise<void> {
    const target = parseTarget(row.target);
    if (!target) {
      state.markDelivery(row.deliveryId, "permanent", { lastError: `invalid target: ${row.target}` });
      state.recordReceipt({
        deliveryId: row.deliveryId,
        attemptId: "invalid-target",
        state: "permanent",
        detail: `invalid target: ${row.target}`,
      });
      notifyDeliveryResult(state, row.deliveryId, this.#onDeliveryResult, { attemptId: "invalid-target", notified: this.#notified });
      log.error(`invalid target ${row.target}`, { account: accountId, delivery: row.deliveryId });
      return;
    }

    const attempt = row.attemptCount + 1;
    const attemptId = `att-${row.deliveryId}-${attempt}`;
    state.markDelivery(row.deliveryId, "in_flight", { attemptCount: attempt });
    const inFlight = this.#inFlight.get(accountId) ?? new Set<string>();
    this.#inFlight.set(accountId, inFlight);
    inFlight.add(row.deliveryId);

    // Start the barrier synchronously before send; the finally below releases it
    // only after applyReceipt commits the receipt and echo mapping. Sends are serial per account.
    this.#gate.begin(accountId);
    try {
      let receipt: SendReceipt;
      try {
        receipt = await adapter.send(
          row.deliveryId,
          attemptId,
          row.idempotencyKey,
          target,
          JSON.parse(row.payload) as unknown,
        );
      } catch (error) {
        receipt = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
      } finally {
        inFlight.delete(row.deliveryId);
      }
      applyReceipt(state, row, attemptId, accountId, receipt, this.#now());
      notifyDeliveryResult(state, row.deliveryId, this.#onDeliveryResult, { attemptId, notified: this.#notified });
    } finally {
      await this.#gate.finish(accountId, (event) => this.#processIngest(event));
      if (this.#disabled.has(accountId)) {
        this.#pauseAccountDeliveries(accountId, "account disabled until restart");
      }
    }
  }

  #pauseAccountDeliveries(accountId: string, reason: string): void {
    const state = this.#state;
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (!state || !account) return;
    try {
      const paused = state.pauseAccountDeliveries(`${account.platform}/${account.id}`, reason);
      if (paused > 0) {
        log.info(`paused ${paused} deliveries for disabled account`, { account: accountId });
      }
    } catch (error) {
      this.#safeWarn(
        `could not pause deliveries: ${error instanceof Error ? error.message : String(error)}`,
        accountId,
      );
    }
  }

  #disableAccount(accountId: string, reason: string): void {
    if (this.#disabled.has(accountId)) return;
    this.#disabled.add(accountId);

    const timer = this.#timers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(accountId);
    }

    const state = this.#state;
    const inFlight = this.#inFlight.get(accountId);
    if (state && inFlight && inFlight.size > 0) {
      for (const deliveryId of inFlight) {
        try {
          state.markDelivery(deliveryId, "unknown", { lastError: reason });
          notifyDeliveryResult(state, deliveryId, this.#onDeliveryResult, { notified: this.#notified });
        } catch (error) {
          this.#safeWarn(
            `could not mark delivery unknown: ${error instanceof Error ? error.message : String(error)}`,
            accountId,
            deliveryId,
          );
        }
      }
      this.#inFlight.delete(accountId);
      this.#safeWarn(`marked ${inFlight.size} in-flight deliveries unknown`, accountId);
    }

    this.#pauseAccountDeliveries(accountId, reason);

    try {
      log.error(`account ${accountId} disabled: ${reason}`, { account: accountId });
    } catch {
      // Logging must not escape the disable path.
    }

    try {
      const adapter = this.#adapters.get(accountId);
      if (adapter) {
        void adapter.stop().catch((error: unknown) => {
          this.#safeWarn(
            `adapter stop failed: ${error instanceof Error ? error.message : String(error)}`,
            accountId,
          );
        });
      }
    } catch (error) {
      this.#safeWarn(
        `adapter stop failed: ${error instanceof Error ? error.message : String(error)}`,
        accountId,
      );
    }
    this.#maybeIdle();
  }

  #handleExit(accountId: string, code: number | null, signal: NodeJS.Signals | null): void {
    try {
      this.#disableAccount(accountId, `adapter exited (code=${code} signal=${signal})`);
    } catch (error) {
      this.#safeWarn(
        `disable after adapter exit failed: ${error instanceof Error ? error.message : String(error)}`,
        accountId,
      );
    }
  }

  #safeWarn(message: string, accountId: string, deliveryId?: string): void {
    try {
      log.warn(message, { account: accountId, delivery: deliveryId });
    } catch {
      // Never throw from a disable/exit path.
    }
  }

  #maybeIdle(): void {
    try {
      if (!this.#running || this.#starting || this.#idleTimer) return;
      if (!this.#config.accounts.every((account) => this.#disabled.has(account.id))) return;
      log.warn("all accounts disabled; host idle until restart");
      this.#idleTimer = setInterval(() => {}, 60_000);
    } catch {
      // Idle bookkeeping must not throw.
    }
  }

  #clearIdle(): void {
    if (!this.#idleTimer) return;
    clearInterval(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #installRejectionGuard(): void {
    if (this.#rejectionHandler) return;
    this.#rejectionHandler = (reason: unknown) => {
      try {
        log.error(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
      } catch {
        // Last resort: never throw from the process guard.
      }
    };
    process.on("unhandledRejection", this.#rejectionHandler);
  }

  #removeRejectionGuard(): void {
    const handler = this.#rejectionHandler;
    if (!handler) return;
    this.#rejectionHandler = undefined;
    try {
      process.off("unhandledRejection", handler);
    } catch {
      // Ignore a partially torn-down process.
    }
  }

  async #stopAdapters(): Promise<void> {
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.stop()));
    this.#adapters.clear();
  }
}

export function createHost(config: ChannelConfig, deps: HostDeps = {}): ChannelHost {
  return new ChannelHost(config, deps);
}