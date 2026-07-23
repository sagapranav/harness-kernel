import { assertJsonSerializable, cloneJson, jsonEqual } from "./json.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";

export type WorkState =
  "queued" | "leased" | "completed" | "failed" | "cancelled" | "dead_lettered";

export interface WorkDeliveryPolicy {
  /** Delivery attempts allowed for one continuation segment. */
  maxAttempts: number;
  /** Successful checkpoint-and-resume boundaries allowed for the work item. */
  maxContinuations: number;
}

/**
 * Durable, provider-neutral unit of execution.
 *
 * Payloads should contain identifiers and immutable configuration references,
 * not credentials or an entire model context.
 */
export interface WorkItem {
  id: string;
  sessionId: string;
  kind: string;
  createdAt: string;
  requiredCapabilities: string[];
  policy: WorkDeliveryPolicy;
  payload?: unknown;
  priority?: number;
  notBefore?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveWorkLease {
  leaseId: string;
  workerId: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface WorkLease extends ActiveWorkLease {
  item: WorkItem;
  /** Attempt number inside the current continuation segment. */
  attempt: number;
  /** Number of successful checkpoint-and-resume boundaries so far. */
  continuationCount: number;
  /** Total deliveries across every segment. */
  totalDeliveryAttempts: number;
}

export interface WorkCompletion {
  completedAt: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface WorkFailure {
  message: string;
  retryable: boolean;
  failedAt: string;
  details?: unknown;
}

export interface WorkCheckpoint {
  reason: string;
  checkpointedAt: string;
  checkpointEventId?: string;
}

export interface WorkCancellation {
  cancelledAt: string;
  reason?: string;
}

export interface WorkRecord {
  item: WorkItem;
  state: WorkState;
  /** Delivery attempts in the current continuation segment. */
  attempt: number;
  continuationCount: number;
  totalDeliveryAttempts: number;
  lastFencingToken: number;
  availableAt: string;
  updatedAt: string;
  lease?: ActiveWorkLease;
  completion?: WorkCompletion;
  checkpoint?: WorkCheckpoint;
  lastFailure?: WorkFailure;
  cancellation?: WorkCancellation;
}

export interface ClaimWorkRequest {
  workerId: string;
  capabilities: string[];
  kinds?: string[];
  visibilityTimeoutMs: number;
}

export interface CompleteWorkInput {
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface CheckpointWorkInput {
  reason: string;
  checkpointEventId?: string;
  /** Absolute ISO timestamp. Omit to make the continuation immediately ready. */
  notBefore?: string;
}

export interface FailWorkInput {
  message: string;
  retryable: boolean;
  details?: unknown;
  /** Absolute ISO timestamp for a retry. */
  retryAt?: string;
}

/**
 * At-least-once execution queue.
 *
 * Distributed adapters must make claim and every lease transition atomic.
 * Lease fencing tokens must increase for every new delivery of one work item.
 */
export interface WorkQueue {
  /** Identical repeated enqueues are idempotent; conflicting values must fail. */
  enqueue(item: WorkItem): Promise<WorkRecord>;
  get(workId: string): Promise<WorkRecord | null>;
  claim(request: ClaimWorkRequest): Promise<WorkLease | null>;
  heartbeat(lease: WorkLease, visibilityTimeoutMs: number): Promise<WorkLease>;
  complete(lease: WorkLease, input?: CompleteWorkInput): Promise<WorkRecord>;
  checkpoint(lease: WorkLease, input: CheckpointWorkInput): Promise<WorkRecord>;
  fail(lease: WorkLease, input: FailWorkInput): Promise<WorkRecord>;
  cancel(workId: string, reason?: string): Promise<WorkRecord>;
}

export class WorkItemConflictError extends Error {
  constructor(readonly workId: string) {
    super(`immutable work item conflict: ${workId}`);
    this.name = "WorkItemConflictError";
  }
}

export class WorkLeaseConflictError extends Error {
  constructor(
    readonly workId: string,
    message = "work lease is no longer current",
  ) {
    super(`${message}: ${workId}`);
    this.name = "WorkLeaseConflictError";
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

function positiveDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function now(runtime: RuntimeServices): string {
  const value = runtime.nowIso();
  timestamp(value, "runtime time");
  return value;
}

function addMilliseconds(value: string, durationMs: number): string {
  return new Date(Date.parse(value) + durationMs).toISOString();
}

function assertStringSet(values: string[], label: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonEmpty(value)) {
      throw new TypeError(`${label} must contain non-empty strings`);
    }
    if (seen.has(value))
      throw new TypeError(`${label} contains ${value} twice`);
    seen.add(value);
  }
}

export function assertWorkItem(item: WorkItem): void {
  assertJsonSerializable(item);
  if (!nonEmpty(item.id)) throw new TypeError("work id must not be empty");
  if (!nonEmpty(item.sessionId))
    throw new TypeError("work session id must not be empty");
  if (!nonEmpty(item.kind)) throw new TypeError("work kind must not be empty");
  timestamp(item.createdAt, "work createdAt");
  assertStringSet(item.requiredCapabilities, "requiredCapabilities");
  if (
    !Number.isSafeInteger(item.policy?.maxAttempts) ||
    item.policy.maxAttempts < 1
  ) {
    throw new TypeError("work maxAttempts must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(item.policy.maxContinuations) ||
    item.policy.maxContinuations < 0
  ) {
    throw new TypeError(
      "work maxContinuations must be a non-negative safe integer",
    );
  }
  if (item.priority !== undefined && !Number.isSafeInteger(item.priority)) {
    throw new TypeError("work priority must be a safe integer");
  }
  if (item.notBefore !== undefined) timestamp(item.notBefore, "work notBefore");
  if (item.idempotencyKey !== undefined && !nonEmpty(item.idempotencyKey)) {
    throw new TypeError("work idempotencyKey must not be empty");
  }
}

function assertClaimRequest(request: ClaimWorkRequest): void {
  if (!nonEmpty(request.workerId))
    throw new TypeError("worker id must not be empty");
  assertStringSet(request.capabilities, "worker capabilities");
  if (request.kinds !== undefined)
    assertStringSet(request.kinds, "worker kinds");
  positiveDuration(request.visibilityTimeoutMs, "visibilityTimeoutMs");
}

function terminal(state: WorkState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "dead_lettered"
  );
}

/**
 * Deterministic single-instance reference queue. Expired leases are recovered
 * lazily on queue operations.
 */
export class MemoryWorkQueue implements WorkQueue {
  private readonly records = new Map<string, WorkRecord>();

  constructor(readonly runtime: RuntimeServices = defaultRuntime) {}

  async enqueue(item: WorkItem): Promise<WorkRecord> {
    assertWorkItem(item);
    const existing = this.records.get(item.id);
    if (existing !== undefined) {
      if (!jsonEqual(existing.item, item))
        throw new WorkItemConflictError(item.id);
      return cloneJson(existing);
    }

    const updatedAt = now(this.runtime);
    const record: WorkRecord = {
      item: cloneJson(item),
      state: "queued",
      attempt: 0,
      continuationCount: 0,
      totalDeliveryAttempts: 0,
      lastFencingToken: 0,
      availableAt: item.notBefore ?? item.createdAt,
      updatedAt,
    };
    this.records.set(item.id, record);
    return cloneJson(record);
  }

  async get(workId: string): Promise<WorkRecord | null> {
    if (!nonEmpty(workId)) throw new TypeError("work id must not be empty");
    this.recoverExpired(now(this.runtime));
    const record = this.records.get(workId);
    return record === undefined ? null : cloneJson(record);
  }

  async claim(request: ClaimWorkRequest): Promise<WorkLease | null> {
    assertClaimRequest(request);
    const claimedAt = now(this.runtime);
    this.recoverExpired(claimedAt);
    const capabilities = new Set(request.capabilities);
    const kinds = request.kinds === undefined ? null : new Set(request.kinds);
    const ready = [...this.records.values()]
      .filter(
        (record) =>
          record.state === "queued" &&
          Date.parse(record.availableAt) <= Date.parse(claimedAt) &&
          record.item.requiredCapabilities.every((capability) =>
            capabilities.has(capability),
          ) &&
          (kinds === null || kinds.has(record.item.kind)),
      )
      .sort((left, right) => {
        const priority = (right.item.priority ?? 0) - (left.item.priority ?? 0);
        if (priority !== 0) return priority;
        const available =
          Date.parse(left.availableAt) - Date.parse(right.availableAt);
        if (available !== 0) return available;
        const created =
          Date.parse(left.item.createdAt) - Date.parse(right.item.createdAt);
        if (created !== 0) return created;
        return left.item.id.localeCompare(right.item.id);
      });
    const record = ready[0];
    if (record === undefined) return null;

    record.attempt += 1;
    record.totalDeliveryAttempts += 1;
    record.lastFencingToken += 1;
    record.state = "leased";
    record.updatedAt = claimedAt;
    record.lease = {
      leaseId: this.runtime.createId("lease"),
      workerId: request.workerId,
      fencingToken: record.lastFencingToken,
      acquiredAt: claimedAt,
      expiresAt: addMilliseconds(claimedAt, request.visibilityTimeoutMs),
    };
    return this.toLease(record);
  }

  async heartbeat(
    lease: WorkLease,
    visibilityTimeoutMs: number,
  ): Promise<WorkLease> {
    positiveDuration(visibilityTimeoutMs, "visibilityTimeoutMs");
    const heartbeatAt = now(this.runtime);
    this.recoverExpired(heartbeatAt);
    const record = this.requireLease(lease);
    record.lease = {
      ...record.lease!,
      expiresAt: addMilliseconds(heartbeatAt, visibilityTimeoutMs),
    };
    record.updatedAt = heartbeatAt;
    return this.toLease(record);
  }

  async complete(
    lease: WorkLease,
    input: CompleteWorkInput = {},
  ): Promise<WorkRecord> {
    assertJsonSerializable(input);
    const completedAt = now(this.runtime);
    this.recoverExpired(completedAt);
    const record = this.requireLease(lease);
    record.state = "completed";
    record.updatedAt = completedAt;
    record.completion = {
      completedAt,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    delete record.lease;
    return cloneJson(record);
  }

  async checkpoint(
    lease: WorkLease,
    input: CheckpointWorkInput,
  ): Promise<WorkRecord> {
    assertJsonSerializable(input);
    if (!nonEmpty(input.reason))
      throw new TypeError("checkpoint reason must not be empty");
    if (
      input.checkpointEventId !== undefined &&
      !nonEmpty(input.checkpointEventId)
    ) {
      throw new TypeError("checkpoint event id must not be empty");
    }
    if (input.notBefore !== undefined)
      timestamp(input.notBefore, "checkpoint notBefore");

    const checkpointedAt = now(this.runtime);
    this.recoverExpired(checkpointedAt);
    const record = this.requireLease(lease);
    record.checkpoint = {
      reason: input.reason,
      checkpointedAt,
      ...(input.checkpointEventId === undefined
        ? {}
        : { checkpointEventId: input.checkpointEventId }),
    };
    record.updatedAt = checkpointedAt;
    delete record.lease;

    if (record.continuationCount >= record.item.policy.maxContinuations) {
      record.state = "dead_lettered";
      record.lastFailure = {
        message: `continuation limit exceeded: ${input.reason}`,
        retryable: false,
        failedAt: checkpointedAt,
      };
      return cloneJson(record);
    }

    record.state = "queued";
    record.continuationCount += 1;
    record.attempt = 0;
    record.availableAt = input.notBefore ?? checkpointedAt;
    return cloneJson(record);
  }

  async fail(lease: WorkLease, input: FailWorkInput): Promise<WorkRecord> {
    assertJsonSerializable(input);
    if (!nonEmpty(input.message))
      throw new TypeError("failure message must not be empty");
    if (typeof input.retryable !== "boolean")
      throw new TypeError("failure retryable must be a boolean");
    if (input.retryAt !== undefined)
      timestamp(input.retryAt, "failure retryAt");

    const failedAt = now(this.runtime);
    this.recoverExpired(failedAt);
    const record = this.requireLease(lease);
    record.lastFailure = {
      message: input.message,
      retryable: input.retryable,
      failedAt,
      ...(input.details === undefined ? {} : { details: input.details }),
    };
    record.updatedAt = failedAt;
    delete record.lease;

    if (!input.retryable) {
      record.state = "failed";
    } else if (record.attempt >= record.item.policy.maxAttempts) {
      record.state = "dead_lettered";
    } else {
      record.state = "queued";
      record.availableAt = input.retryAt ?? failedAt;
    }
    return cloneJson(record);
  }

  async cancel(workId: string, reason?: string): Promise<WorkRecord> {
    if (!nonEmpty(workId)) throw new TypeError("work id must not be empty");
    if (reason !== undefined && typeof reason !== "string")
      throw new TypeError("cancellation reason must be a string");
    const cancelledAt = now(this.runtime);
    this.recoverExpired(cancelledAt);
    const record = this.records.get(workId);
    if (record === undefined) throw new Error(`work item not found: ${workId}`);
    if (record.state === "cancelled") return cloneJson(record);
    if (terminal(record.state)) {
      throw new Error(`cannot cancel ${record.state} work: ${workId}`);
    }
    record.state = "cancelled";
    record.updatedAt = cancelledAt;
    record.cancellation = {
      cancelledAt,
      ...(reason === undefined ? {} : { reason }),
    };
    delete record.lease;
    return cloneJson(record);
  }

  private recoverExpired(observedAt: string): void {
    for (const record of this.records.values()) {
      if (
        record.state !== "leased" ||
        record.lease === undefined ||
        Date.parse(record.lease.expiresAt) > Date.parse(observedAt)
      ) {
        continue;
      }
      const failedAt = observedAt;
      record.lastFailure = {
        message: "work lease expired before acknowledgement",
        retryable: true,
        failedAt,
      };
      record.updatedAt = observedAt;
      delete record.lease;
      if (record.attempt >= record.item.policy.maxAttempts) {
        record.state = "dead_lettered";
      } else {
        record.state = "queued";
        record.availableAt = observedAt;
      }
    }
  }

  private requireLease(lease: WorkLease): WorkRecord {
    const record = this.records.get(lease.item.id);
    const active = record?.lease;
    if (
      record === undefined ||
      record.state !== "leased" ||
      active === undefined ||
      active.leaseId !== lease.leaseId ||
      active.workerId !== lease.workerId ||
      active.fencingToken !== lease.fencingToken
    ) {
      throw new WorkLeaseConflictError(lease.item.id);
    }
    return record;
  }

  private toLease(record: WorkRecord): WorkLease {
    if (record.state !== "leased" || record.lease === undefined) {
      throw new Error(`work item is not leased: ${record.item.id}`);
    }
    return cloneJson({
      ...record.lease,
      item: record.item,
      attempt: record.attempt,
      continuationCount: record.continuationCount,
      totalDeliveryAttempts: record.totalDeliveryAttempts,
    });
  }
}

export type WorkResolution =
  | {
      status: "completed";
      result?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "checkpointed";
      reason: string;
      checkpointEventId?: string;
      notBefore?: string;
    }
  | {
      status: "failed";
      message: string;
      retryable: boolean;
      details?: unknown;
      retryAt?: string;
    }
  | { status: "cancelled"; reason?: string };

export interface WorkHandlerContext {
  readonly workerId: string;
  readonly signal?: AbortSignal;
  /**
   * Extend the queue visibility lease. Long-running handlers should call this
   * before each bounded step rather than assuming process liveness is ownership.
   */
  heartbeat(visibilityTimeoutMs?: number): Promise<WorkLease>;
}

export interface WorkHandler {
  handle(item: WorkItem, context: WorkHandlerContext): Promise<WorkResolution>;
}

export interface WorkerHostOptions {
  queue: WorkQueue;
  workerId: string;
  capabilities: string[];
  handlers: Readonly<Record<string, WorkHandler>>;
  visibilityTimeoutMs: number;
  signal?: AbortSignal;
}

export type WorkerRunOutcome =
  | { status: "idle" }
  | {
      status: "processed";
      workId: string;
      resolution: WorkResolution["status"] | "threw";
      record: WorkRecord;
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes at most one queue delivery. Polling, concurrency, process signals,
 * and deployment lifecycle remain the host CLI/service's responsibility.
 */
export class WorkerHost {
  constructor(readonly options: WorkerHostOptions) {
    if (!nonEmpty(options.workerId))
      throw new TypeError("worker id must not be empty");
    assertStringSet(options.capabilities, "worker capabilities");
    positiveDuration(options.visibilityTimeoutMs, "visibilityTimeoutMs");
    const kinds = Object.keys(options.handlers);
    assertStringSet(kinds, "worker handler kinds");
    if (kinds.length === 0)
      throw new TypeError("worker host requires at least one handler");
    for (const kind of kinds) {
      if (typeof options.handlers[kind]?.handle !== "function") {
        throw new TypeError(`worker handler ${kind} is invalid`);
      }
    }
  }

  async runOne(): Promise<WorkerRunOutcome> {
    if (this.options.signal?.aborted === true) return { status: "idle" };
    let lease = await this.options.queue.claim({
      workerId: this.options.workerId,
      capabilities: this.options.capabilities,
      kinds: Object.keys(this.options.handlers),
      visibilityTimeoutMs: this.options.visibilityTimeoutMs,
    });
    if (lease === null) return { status: "idle" };

    const handler = this.options.handlers[lease.item.kind]!;
    let resolution: WorkResolution;
    let resolutionName: WorkResolution["status"] | "threw";
    try {
      resolution = await handler.handle(lease.item, {
        workerId: this.options.workerId,
        ...(this.options.signal === undefined
          ? {}
          : { signal: this.options.signal }),
        heartbeat: async (visibilityTimeoutMs) => {
          lease = await this.options.queue.heartbeat(
            lease!,
            visibilityTimeoutMs ?? this.options.visibilityTimeoutMs,
          );
          return lease;
        },
      });
      assertJsonSerializable(resolution);
      resolutionName = resolution.status;
    } catch (error) {
      resolution = {
        status: "failed",
        message: errorText(error),
        retryable: true,
        details: { thrown: true },
      };
      resolutionName = "threw";
    }

    let record: WorkRecord;
    switch (resolution.status) {
      case "completed":
        record = await this.options.queue.complete(lease, {
          ...(resolution.result === undefined
            ? {}
            : { result: resolution.result }),
          ...(resolution.metadata === undefined
            ? {}
            : { metadata: resolution.metadata }),
        });
        break;
      case "checkpointed":
        record = await this.options.queue.checkpoint(lease, {
          reason: resolution.reason,
          ...(resolution.checkpointEventId === undefined
            ? {}
            : { checkpointEventId: resolution.checkpointEventId }),
          ...(resolution.notBefore === undefined
            ? {}
            : { notBefore: resolution.notBefore }),
        });
        break;
      case "failed":
        record = await this.options.queue.fail(lease, {
          message: resolution.message,
          retryable: resolution.retryable,
          ...(resolution.details === undefined
            ? {}
            : { details: resolution.details }),
          ...(resolution.retryAt === undefined
            ? {}
            : { retryAt: resolution.retryAt }),
        });
        break;
      case "cancelled":
        record = await this.options.queue.cancel(
          lease.item.id,
          resolution.reason,
        );
        break;
      default:
        throw new TypeError("worker handler returned an unknown resolution");
    }
    return {
      status: "processed",
      workId: lease.item.id,
      resolution: resolutionName,
      record,
    };
  }
}
