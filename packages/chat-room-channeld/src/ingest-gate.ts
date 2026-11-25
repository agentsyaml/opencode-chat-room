import { log } from "./log.ts";
import type { IngestEvent } from "./protocol.ts";

export interface IngestResult {
  duplicate: boolean;
  eventId?: string;
}

export type IngestProcessor = (event: IngestEvent) => Promise<IngestResult>;
export type OverflowHandler = (accountId: string, event: IngestEvent, error: Error) => void;

interface BufferedIngest {
  event: IngestEvent;
  resolve(result: IngestResult): void;
  reject(error: Error): void;
}

interface GateState {
  sends: number;
  draining: boolean;
  queue: BufferedIngest[];
  overflow?: Error;
}

export const MAX_BUFFERED_INGESTS = 100;

/**
 * Serializes inbound ingest handling behind in-flight sends per account. A
 * counter, not a boolean, keeps buffered events parked until every started send
 * has settled. Overflow is reported to the owner, which disables the account.
 */
export class IngestGate {
  readonly #onOverflow: OverflowHandler;
  readonly #gates = new Map<string, GateState>();

  constructor(onOverflow: OverflowHandler) {
    this.#onOverflow = onOverflow;
  }

  begin(accountId: string): void {
    const gate = this.#gate(accountId);
    gate.sends += 1;
  }

  async finish(accountId: string, process: IngestProcessor): Promise<void> {
    const gate = this.#gates.get(accountId);
    if (!gate) return;
    gate.sends = Math.max(0, gate.sends - 1);
    if (gate.sends > 0 || gate.draining) return;

    gate.draining = true;
    try {
      while (gate.queue.length > 0) {
        const item = gate.queue.shift()!;
        try {
          item.resolve(await process(item.event));
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      gate.draining = false;
      if (gate.sends === 0 && gate.queue.length === 0) this.#gates.delete(accountId);
    }
  }

  async run(accountId: string, event: IngestEvent, process: IngestProcessor): Promise<IngestResult> {
    const gate = this.#gates.get(accountId);
    if (!gate || (!gate.draining && gate.sends === 0)) return process(event);
    if (gate.overflow) throw gate.overflow;
    if (gate.queue.length >= MAX_BUFFERED_INGESTS) {
      const error = new Error(
        `ingest buffer overflow for account ${accountId}; limit ${MAX_BUFFERED_INGESTS}; event ${event.eventId} dropped`,
      ) as Error & { code?: string };
      error.code = "ingest_buffer_overflow";
      gate.overflow = error;
      try {
        log.error(error.message, { account: accountId, event: event.eventId });
      } catch {
        // Logging must not break the overflow path.
      }
      try {
        this.#onOverflow(accountId, event, error);
      } catch (callbackError) {
        try {
          log.error(
            `overflow handler failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
            { account: accountId },
          );
        } catch {
          // Keep the overflow rejection.
        }
      }
      throw error;
    }
    return new Promise<IngestResult>((resolve, reject) => {
      gate.queue.push({ event, resolve, reject });
    });
  }

  #gate(accountId: string): GateState {
    const existing = this.#gates.get(accountId);
    if (existing) return existing;
    const gate: GateState = { sends: 0, draining: false, queue: [] };
    this.#gates.set(accountId, gate);
    return gate;
  }
}