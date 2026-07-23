import {
  assertExpectedJournalHead,
  assertSessionId,
  createJournalEvent,
  selectJournalEvents,
  type AppendOptions,
  type JournalReadOptions,
  type JournalStore,
} from "./journal.js";
import { cloneJson } from "./json.js";
import type { AppendEventInput, JournalEvent } from "./protocol.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";

export interface ExecutionLease {
  sessionId: string;
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireExecutionLeaseRequest {
  sessionId: string;
  ownerId: string;
  durationMs: number;
}

/**
 * Journal contract for strict single-writer session execution.
 *
 * A distributed implementation must validate the fencing token in the same
 * transaction as append. Checking a lease in a separate service call leaves a
 * race in which an expired worker can still write after a new worker starts.
 */
export interface FencedJournalStore extends JournalStore {
  acquireExecutionLease(
    request: AcquireExecutionLeaseRequest,
  ): Promise<ExecutionLease | null>;
  renewExecutionLease(
    lease: ExecutionLease,
    durationMs: number,
  ): Promise<ExecutionLease>;
  releaseExecutionLease(lease: ExecutionLease): Promise<void>;
  appendFenced<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    lease: ExecutionLease,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>>;
}

export class ExecutionLeaseConflictError extends Error {
  constructor(
    readonly sessionId: string,
    message = "execution lease is no longer current",
  ) {
    super(`${message}: ${sessionId}`);
    this.name = "ExecutionLeaseConflictError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-compatible timestamp`);
  }
}

function positiveDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "execution lease duration must be a positive safe integer",
    );
  }
}

function addMilliseconds(value: string, durationMs: number): string {
  return new Date(Date.parse(value) + durationMs).toISOString();
}

function observedAt(runtime: RuntimeServices): string {
  const value = runtime.nowIso();
  timestamp(value, "runtime time");
  return value;
}

/**
 * Binds an execution lease to the ordinary JournalStore interface consumed by
 * runAgentLoop(). Every append made through the returned view is fenced.
 */
export function bindExecutionLease(
  journal: FencedJournalStore,
  lease: ExecutionLease,
): JournalStore {
  return {
    append(sessionId, input, options) {
      return journal.appendFenced(sessionId, input, lease, options);
    },
    read(sessionId, options) {
      return journal.read(sessionId, options);
    },
    head(sessionId) {
      return journal.head(sessionId);
    },
  };
}

/**
 * Single-instance reference implementation of atomic fenced appends.
 */
export class MemoryFencedJournalStore implements FencedJournalStore {
  private readonly sessions = new Map<string, JournalEvent[]>();
  private readonly activeLeases = new Map<string, ExecutionLease>();
  private readonly lastFencingTokens = new Map<string, number>();

  constructor(readonly runtime: RuntimeServices = defaultRuntime) {}

  async acquireExecutionLease(
    request: AcquireExecutionLeaseRequest,
  ): Promise<ExecutionLease | null> {
    assertSessionId(request.sessionId);
    if (!nonEmpty(request.ownerId))
      throw new TypeError("execution lease owner id must not be empty");
    positiveDuration(request.durationMs);
    const acquiredAt = observedAt(this.runtime);
    const active = this.activeLeases.get(request.sessionId);
    if (
      active !== undefined &&
      Date.parse(active.expiresAt) > Date.parse(acquiredAt)
    ) {
      return active.ownerId === request.ownerId ? cloneJson(active) : null;
    }

    const fencingToken =
      (this.lastFencingTokens.get(request.sessionId) ?? 0) + 1;
    const lease: ExecutionLease = {
      sessionId: request.sessionId,
      leaseId: this.runtime.createId("execution_lease"),
      ownerId: request.ownerId,
      fencingToken,
      acquiredAt,
      expiresAt: addMilliseconds(acquiredAt, request.durationMs),
    };
    this.lastFencingTokens.set(request.sessionId, fencingToken);
    this.activeLeases.set(request.sessionId, lease);
    return cloneJson(lease);
  }

  async renewExecutionLease(
    lease: ExecutionLease,
    durationMs: number,
  ): Promise<ExecutionLease> {
    positiveDuration(durationMs);
    const renewedAt = observedAt(this.runtime);
    const active = this.requireLease(lease, renewedAt);
    const renewed: ExecutionLease = {
      ...active,
      expiresAt: addMilliseconds(renewedAt, durationMs),
    };
    this.activeLeases.set(lease.sessionId, renewed);
    return cloneJson(renewed);
  }

  async releaseExecutionLease(lease: ExecutionLease): Promise<void> {
    const releasedAt = observedAt(this.runtime);
    this.requireLease(lease, releasedAt);
    this.activeLeases.delete(lease.sessionId);
  }

  async appendFenced<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    lease: ExecutionLease,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    if (sessionId !== lease.sessionId) {
      throw new ExecutionLeaseConflictError(
        sessionId,
        "execution lease belongs to another session",
      );
    }
    this.requireLease(lease, observedAt(this.runtime));
    return this.appendInternal(sessionId, input, options);
  }

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    return this.appendInternal(sessionId, input, options);
  }

  async read(
    sessionId: string,
    options?: JournalReadOptions,
  ): Promise<JournalEvent[]> {
    assertSessionId(sessionId);
    return cloneJson(
      selectJournalEvents(this.sessions.get(sessionId) ?? [], options),
    );
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    assertSessionId(sessionId);
    const head = this.sessions.get(sessionId)?.at(-1);
    return head === undefined ? null : cloneJson(head);
  }

  private appendInternal<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): JournalEvent<TData> {
    const events = this.sessions.get(sessionId) ?? [];
    const head = events.at(-1) ?? null;
    assertExpectedJournalHead(head, options);
    const event = createJournalEvent(sessionId, head, input, this.runtime);
    const stored = cloneJson(event);
    events.push(stored as JournalEvent);
    this.sessions.set(sessionId, events);
    return cloneJson(stored);
  }

  private requireLease(
    lease: ExecutionLease,
    checkedAt: string,
  ): ExecutionLease {
    const active = this.activeLeases.get(lease.sessionId);
    if (
      active === undefined ||
      active.leaseId !== lease.leaseId ||
      active.ownerId !== lease.ownerId ||
      active.fencingToken !== lease.fencingToken ||
      Date.parse(active.expiresAt) <= Date.parse(checkedAt)
    ) {
      throw new ExecutionLeaseConflictError(lease.sessionId);
    }
    return active;
  }
}
