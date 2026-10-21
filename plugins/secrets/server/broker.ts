import { randomUUID } from "node:crypto";
import type { SecretRow } from "../shared/contracts";
import { hasSecret, type Storage, StoreError, writeSecret } from "./store";

export const REQUEST_TTL_MS = 15 * 60 * 1000;

export type Outcome =
  | { status: "stored"; name: string; path: string }
  | { status: "waiting"; requestId: string; name: string }
  | { status: "cancelled" | "expired"; name: string };

interface Pending {
  requestId: string;
  agentId: string;
  name: string;
  purpose: string;
  replacing: boolean;
  outcome: Outcome;
  waiters: Array<(outcome: Outcome) => void>;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrokerDeps {
  dir: string;
  storage: Storage;
  /** Put the row in the agent's timeline, or replace it. The row holds no secret. */
  publish(agentId: string, rowId: string, row: SecretRow): Promise<void>;
  ttlMs?: number;
}

export function rowId(requestId: string): string {
  return `secret-${requestId}`;
}

/**
 * The state of every open secret request. A request ends in exactly one of
 * three ways: stored, cancelled, expired. Only `submit` ever sees a value, and
 * it hands it straight to the store.
 */
export class Broker {
  private readonly requests = new Map<string, Pending>();

  constructor(private readonly deps: BrokerDeps) {}

  /** Open a request, or return the one already waiting for this agent and name. */
  async request(agentId: string, name: string, purpose: string): Promise<Outcome> {
    const already = this.openRequest(agentId, name);
    if (already) return already;
    const requestId = randomUUID();
    const pending: Pending = {
      requestId,
      agentId,
      name,
      purpose,
      replacing: hasSecret(this.deps.dir, name),
      outcome: { status: "waiting", requestId, name },
      waiters: [],
      timer: setTimeout(() => void this.finish(requestId, "expired"), this.deps.ttlMs ?? REQUEST_TTL_MS),
    };
    pending.timer.unref?.();
    this.requests.set(requestId, pending);
    try {
      await this.publishRow(pending);
    } catch (error) {
      // If the operator cannot see the box, nobody can answer. Do not leave the agent waiting for it.
      clearTimeout(pending.timer);
      this.requests.delete(requestId);
      throw error;
    }
    return pending.outcome;
  }

  /** The request this agent has open for this name, if any. */
  openRequest(agentId: string, name: string): Outcome | undefined {
    for (const pending of this.requests.values()) {
      if (pending.agentId === agentId && pending.name === name && pending.outcome.status === "waiting") {
        return pending.outcome;
      }
    }
    return undefined;
  }

  /** Wait for a request to end, or return `waiting` after `waitMs`. */
  wait(requestId: string, waitMs: number): Promise<Outcome | undefined> {
    const pending = this.requests.get(requestId);
    if (!pending) return Promise.resolve(undefined);
    if (pending.outcome.status !== "waiting") return Promise.resolve(pending.outcome);
    return new Promise((resolve) => {
      // Not unref'd: someone is waiting on this, so it must keep the process alive.
      const timer = setTimeout(() => resolve(pending.outcome), waitMs);
      pending.waiters.push((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /** The operator pressed Save. The value is written and then forgotten. */
  async submit(requestId: string, value: string): Promise<{ ok: boolean; message?: string }> {
    const pending = this.requests.get(requestId);
    if (!pending || pending.outcome.status !== "waiting") {
      return { ok: false, message: "This request is no longer open." };
    }
    let path: string;
    try {
      path = writeSecret(this.deps.dir, pending.name, value);
    } catch (error) {
      // Only our own StoreError text is safe to show. Anything else may quote a path.
      return { ok: false, message: error instanceof StoreError ? error.message : "Could not save the secret." };
    }
    await this.finish(requestId, "stored", path);
    return { ok: true };
  }

  async cancel(requestId: string): Promise<boolean> {
    const pending = this.requests.get(requestId);
    if (!pending || pending.outcome.status !== "waiting") return false;
    await this.finish(requestId, "cancelled");
    return true;
  }

  private async finish(requestId: string, status: "stored" | "cancelled" | "expired", path?: string): Promise<void> {
    const pending = this.requests.get(requestId);
    if (!pending || pending.outcome.status !== "waiting") return;
    clearTimeout(pending.timer);
    pending.outcome =
      status === "stored" && path
        ? { status: "stored", name: pending.name, path }
        : { status: status === "stored" ? "expired" : status, name: pending.name };
    for (const waiter of pending.waiters.splice(0)) waiter(pending.outcome);
    await this.publishQuietly(pending);
  }

  /** Put the row in the timeline. Throws; callers decide whether that matters. */
  private async publishRow(pending: Pending): Promise<void> {
    await this.deps.publish(pending.agentId, rowId(pending.requestId), {
      requestId: pending.requestId,
      name: pending.name,
      purpose: pending.purpose,
      status: pending.outcome.status,
      replacing: pending.replacing,
      storage: this.deps.storage,
    });
  }

  /** A later update (stored, cancelled, expired) failing to show must not undo what already happened. */
  private async publishQuietly(pending: Pending): Promise<void> {
    try {
      await this.publishRow(pending);
    } catch (error) {
      console.error("Could not update the timeline row:", error instanceof Error ? error.message : "unknown error");
    }
  }
}
