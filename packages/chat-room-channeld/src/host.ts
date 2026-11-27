import type { AccountConfig, ChannelConfig, RuleTarget } from "./config.ts";
import { AdapterProcess, type SendReceipt } from "./adapter.ts";
import { applyReceipt, notifyDeliveryResult, type DeliveryResultHandler } from "./delivery.ts";
import { parseTarget, startFailureReason, toEndpoint, validateTargets } from "./host-helpers.ts";
import { IngestGate, type IngestResult } from "./ingest-gate.ts";
import { log } from "./log.ts";
import type { AdapterCapabilities, Endpoint, IngestEvent, MessageRef } from "./protocol.ts";
import { matchRules, planPayload, sameEndpoint, targetKey } from "./rules.ts";
import type { ChannelAccountRuntime } from "./stats.ts";
import { sanitizeAccountError } from "./stats.ts";
import { openState, type ChannelState, type DeliveryRow } from "./state.ts";

export type { IngestResult } from "./ingest-gate.ts";

export interface AdapterHandle {
  /** Optional platform facts declared by the adapter during initialize. */
  readonly capabilities?: AdapterCapabilities;
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
  onStatus(status: { inbound?: string; detail?: string }): void;
}

export type SpawnAdapter = (account: AccountConfig, context: SpawnAdapterContext) => AdapterHandle;

export interface HostDeps {
  stateFactory?: (path: string) => ChannelState;
  spawnAdapter?: SpawnAdapter;
  now?: () => number;
  deliveryIntervalMs?: number;
  onDeliveryResult?: DeliveryResultHandler;
  /**
   * Called once for a newly committed ingest event, never for duplicates or
   * echoes. The host awaits it before reporting success: for an inbound
   * notification, a rejection rolls the event back and becomes an ingest error
   * so the provider retries instead of ACKing a lost message. Duplicate/replay
   * suppression is durable via the event dedup key.
   */
  onIngestCommitted?: (event: IngestEvent) => Promise<void> | void;
  /** Events used as inbound room notifications must not match outbound rules. */
  notificationOnly?: (event: IngestEvent) => boolean;
  /**
   * Resolve a stored delivery payload into the adapter's wire form right before
   * a send. The host calls cleanup after the attempt, whether it succeeded or not.
   */
  prepareSendPayload?: (payload: unknown, capabilities?: AdapterCapabilities) => Promise<{
    payload: unknown;
    cleanup?: () => Promise<void>;
  }>;
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
  readonly #onIngestCommitted?: (event: IngestEvent) => Promise<void> | void;
  readonly #notificationOnly?: (event: IngestEvent) => boolean;
  readonly #prepareSendPayload?: HostDeps["prepareSendPayload"];
  readonly #adapters = new Map<string, AdapterHandle>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Map<string, Set<string>>();
  readonly #notified = new Set<string>();
  readonly #active = new Set<Promise<void>>();
  readonly #disabled = new Set<string>();
  readonly #accountStates = new Map<string, ChannelAccountRuntime>();
  readonly #gate = new IngestGate((accountId, _event, _error) => {
    this.#disableAccount(accountId, "ingest barrier limit reached");
  });
  #state?: ChannelState;
  #running = false;
  #starting = false;
  #stopReason?: string;
  #idleTimer?: ReturnType<typeof setInterval>;
  #rejectionHandler?: (reason: unknown) => void;

  constructor(config: ChannelConfig, deps: HostDeps = {}) {
    this.#config = config;
    this.#stateFactory = deps.stateFactory ?? openState;
    this.#spawnAdapter = deps.spawnAdapter ?? defaultSpawnAdapter;
    this.#now = deps.now ?? Date.now;
    this.#deliveryIntervalMs = deps.deliveryIntervalMs ?? 200;
    this.#onDeliveryResult = deps.onDeliveryResult;
    this.#onIngestCommitted = deps.onIngestCommitted;
    this.#notificationOnly = deps.notificationOnly;
    this.#prepareSendPayload = deps.prepareSendPayload;
  }

  /** Account ids whose adapter failed to start or exited; their queues stay paused. */
  get disabledAccounts(): readonly string[] {
    return [...this.#disabled];
  }

  /** Live per-account state keyed by `platform/account`, including startup failures. */
  get accountRuntimeStates(): ReadonlyMap<string, ChannelAccountRuntime> {
    return new Map(this.#accountStates);
  }

  /** Read-only view for routes: unknown ids or platform mismatches are missing. */
  targetStatus(platform: string, accountId: string): "ready" | "disabled" | "missing" {
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (!account || account.platform !== platform) return "missing";
    return this.#disabled.has(accountId) ? "disabled" : "ready";
  }

  /** Latest provider message sent for a logical room message, for native replies. */
  findProviderMessage(endpoint: Endpoint, logicalMessageId: string): MessageRef | undefined {
    const state = this.#state;
    if (!state || !logicalMessageId) return undefined;
    const nativeMessageId = state.findProviderMessage(targetKey(endpoint), logicalMessageId);
    return nativeMessageId ? { endpoint, nativeMessageId } : undefined;
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
          onStatus: (status) => this.#handleAdapterStatus(account.id, status),
        });
        this.#adapters.set(account.id, adapter);
        await adapter.start();
        const current = this.#accountStates.get(`${account.platform}/${account.id}`);
        this.#setAccountState(account, "started", current?.lastError);
        this.#schedule(account.id);
        return { id: account.id };
      } catch (error) {
        const reason = startFailureReason(account.id, error);
        this.#setAccountState(account, "failed", reason);
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
        this.#setAccountState(account, "failed", reason);
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
      this.#accountStates.clear();
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

    if (this.#onIngestCommitted) {
      try {
        await this.#onIngestCommitted(stored);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An inbound notification owns the ACK: roll back and fail the ingest so
        // the provider retries. Other consumer failures stay contained as before.
        if (this.#notificationOnly?.(stored)) {
          state.deleteIngestEvent(stored.eventId);
          log.error(`inbound commit rolled back: ${message}`, { event: stored.eventId });
          throw error;
        }
        log.warn(`onIngestCommitted failed: ${message}`, { event: stored.eventId });
      }
    }

    if (this.#notificationOnly?.(stored)) {
      log.info("inbound notification only; outbound rules skipped", { event: stored.eventId });
      return { duplicate: false, eventId: stored.eventId };
    }

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

  async stop(options: { abortInFlight?: boolean } = {}): Promise<void> {
    if (!this.#running && !this.#state) {
      this.#clearIdle();
      this.#removeRejectionGuard();
      return;
    }
    this.#running = false;
    this.#starting = false;
    const stopReason = "relay runtime stopped";
    this.#stopReason = stopReason;
    this.#clearIdle();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (options.abortInFlight) {
      this.#settleInFlightUnknown(stopReason);
      await this.#stopAdapters();
    }
    await Promise.allSettled([...this.#active]);
    this.#settleInFlightUnknown(stopReason);
    await this.#stopAdapters();
    this.#state?.close();
    this.#state = undefined;
    this.#adapters.clear();
    this.#inFlight.clear();
    this.#notified.clear();
    this.#disabled.clear();
    this.#accountStates.clear();
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
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const stored = JSON.parse(row.payload) as unknown;
        if (this.#prepareSendPayload) {
          const prepared = await this.#prepareSendPayload(stored, adapter.capabilities);
          cleanup = prepared.cleanup;
          receipt = await adapter.send(row.deliveryId, attemptId, row.idempotencyKey, target, prepared.payload);
        } else {
          receipt = await adapter.send(row.deliveryId, attemptId, row.idempotencyKey, target, stored);
        }
      } catch (error) {
        receipt = { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
      } finally {
        inFlight.delete(row.deliveryId);
        await cleanup?.().catch(() => undefined);
      }
      // A host stop wins over a late send result: reload must not auto-resend.
      if (this.#stopReason) receipt = { state: "unknown", detail: this.#stopReason };
      applyReceipt(state, row, attemptId, accountId, receipt, this.#now());
      notifyDeliveryResult(state, row.deliveryId, this.#onDeliveryResult, { attemptId, notified: this.#notified });
    } finally {
      await this.#gate.finish(accountId, (event) => this.#processIngest(event));
      if (this.#disabled.has(accountId)) {
        this.#pauseAccountDeliveries(accountId, "account disabled until restart");
      }
    }
  }

  /** Stop must never leave rows that the next host would auto-resend. */
  #settleInFlightUnknown(reason: string): void {
    const state = this.#state;
    if (!state) return;
    for (const [accountId, deliveryIds] of this.#inFlight) {
      for (const deliveryId of deliveryIds) {
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
    }
    this.#inFlight.clear();
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

  /** Inbound health is advisory: failures must not disable a working outbound account. */
  #handleAdapterStatus(accountId: string, status: { inbound?: string; detail?: string }): void {
    if (this.#disabled.has(accountId)) return;
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (!account) return;
    const key = `${account.platform}/${account.id}`;
    if (status.inbound === "failed") {
      const detail = sanitizeAccountError(`inbound failed: ${status.detail ?? "unknown"}`);
      this.#accountStates.set(key, { state: "started", lastError: detail });
      log.warn(detail, { account: accountId });
    } else if (status.inbound === "ready") {
      this.#accountStates.set(key, { state: "started" });
    }
  }

  #setAccountState(
    account: AccountConfig,
    state: ChannelAccountRuntime["state"],
    lastError?: string,
  ): void {
    this.#accountStates.set(
      `${account.platform}/${account.id}`,
      lastError ? { state, lastError } : { state },
    );
  }

  #disableAccount(accountId: string, reason: string): void {
    if (this.#disabled.has(accountId)) return;
    this.#disabled.add(accountId);
    const account = this.#config.accounts.find((item) => item.id === accountId);
    if (account) this.#setAccountState(account, "disabled", reason);

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