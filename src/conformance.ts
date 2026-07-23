import { ArtifactIntegrityError, type ArtifactStore } from "./artifacts.js";
import {
  bindExecutionLease,
  ExecutionLeaseConflictError,
  type FencedJournalStore,
} from "./execution.js";
import {
  JournalConflictError,
  validateChain,
  type JournalStore,
} from "./journal.js";
import type { ProjectionSnapshot, ProjectionStore } from "./projection.js";
import type { ImmutableRunConfig, SessionDescriptor } from "./protocol.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import type { SessionCatalog } from "./sessions.js";
import type { HarnessStorage } from "./storage.js";
import {
  WorkItemConflictError,
  WorkLeaseConflictError,
  type WorkItem,
  type WorkQueue,
} from "./work.js";

export interface ConformanceCheck {
  scope:
    | "profile"
    | "runtime"
    | "journal"
    | "artifacts"
    | "projections"
    | "sessions"
    | "work"
    | "execution";
  name: string;
  passed: boolean;
  error?: string;
}

export interface StorageConformanceReport {
  adapter: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

export class StorageConformanceError extends Error {
  constructor(readonly report: StorageConformanceReport) {
    super(
      `storage conformance failed for ${report.adapter}: ${report.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.scope}/${check.name}: ${check.error}`)
        .join("; ")}`,
    );
    this.name = "StorageConformanceError";
  }
}

export interface OrchestrationConformanceReport {
  adapter: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

export class OrchestrationConformanceError extends Error {
  constructor(readonly report: OrchestrationConformanceReport) {
    super(
      `orchestration conformance failed for ${report.adapter}: ${report.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.scope}/${check.name}: ${check.error}`)
        .join("; ")}`,
    );
    this.name = "OrchestrationConformanceError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function check(
  checks: ConformanceCheck[],
  scope: ConformanceCheck["scope"],
  name: string,
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    await operation();
    checks.push({ scope, name, passed: true });
  } catch (error) {
    checks.push({ scope, name, passed: false, error: errorText(error) });
  }
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export async function checkRuntimeServices(
  runtime: RuntimeServices,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  await check(checks, "runtime", "identifiers are unique strings", () => {
    const first = runtime.createId("conformance");
    const second = runtime.createId("conformance");
    requireCondition(first.length > 0, "runtime returned an empty identifier");
    requireCondition(first !== second, "runtime identifiers are not unique");
  });
  await check(checks, "runtime", "timestamps are parseable", () => {
    requireCondition(
      !Number.isNaN(Date.parse(runtime.nowIso())),
      "runtime timestamp is invalid",
    );
  });
  await check(checks, "runtime", "SHA-256 is canonical", async () => {
    const digest = await runtime.sha256(new TextEncoder().encode("abc"));
    requireCondition(
      digest ===
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "runtime SHA-256 does not match the standard vector",
    );
  });
  return checks;
}

/** Runs the append, conflict, linearization, and isolation contract. */
export async function checkJournalStore(
  store: JournalStore,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const sessionId = runtime.createId("journal_conformance");
  let firstId = "";

  await check(checks, "journal", "append snapshots input", async () => {
    const data = { nested: { value: 1 } };
    const pending = store.append(
      sessionId,
      { category: "trace", type: "conformance.first", data },
      { expectedHeadId: null },
    );
    data.nested.value = 2;
    const event = await pending;
    firstId = event.id;
    requireCondition(event.sequence === 1, "first sequence is not 1");
    requireCondition(
      (event.data as typeof data).nested.value === 1,
      "append retained caller mutation",
    );
  });

  await check(checks, "journal", "conditional append conflicts", async () => {
    let conflict: unknown;
    try {
      await store.append(
        sessionId,
        { category: "trace", type: "conformance.conflict", data: {} },
        { expectedHeadId: null },
      );
    } catch (error) {
      conflict = error;
    }
    requireCondition(
      conflict instanceof JournalConflictError,
      "stale expectedHeadId did not throw JournalConflictError",
    );
  });

  await check(checks, "journal", "concurrent appends linearize", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.append(sessionId, {
          category: "trace",
          type: "conformance.concurrent",
          data: { index },
        }),
      ),
    );
    const events = await store.read(sessionId);
    requireCondition(events.length === 9, "concurrent append lost an event");
    validateChain(sessionId, events);
    requireCondition(events[0]?.id === firstId, "first event changed");
  });

  await check(
    checks,
    "journal",
    "concurrent conditional appends are exclusive",
    async () => {
      const expected = (await store.head(sessionId))?.id ?? null;
      const results = await Promise.allSettled(
        [0, 1].map((index) =>
          store.append(
            sessionId,
            { category: "trace", type: "conformance.cas", data: { index } },
            { expectedHeadId: expected },
          ),
        ),
      );
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const conflicts = results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof JournalConflictError,
      );
      requireCondition(
        fulfilled.length === 1 && conflicts.length === 1,
        "concurrent conditional appends did not resolve into one success and one JournalConflictError",
      );
      validateChain(sessionId, await store.read(sessionId));
    },
  );

  await check(checks, "journal", "reads are isolated copies", async () => {
    const firstRead = await store.read(sessionId);
    (firstRead[0]!.data as { nested: { value: number } }).nested.value = 99;
    const secondRead = await store.read(sessionId);
    requireCondition(
      (secondRead[0]!.data as { nested: { value: number } }).nested.value === 1,
      "read exposed mutable store state",
    );
    requireCondition(
      (await store.head(sessionId))?.id === secondRead.at(-1)?.id,
      "head does not match the journal tail",
    );
  });

  return checks;
}

/** Runs content-address, integrity, idempotence, and isolation checks. */
export async function checkArtifactStore(
  store: ArtifactStore,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  let reference: Awaited<ReturnType<ArtifactStore["put"]>> | undefined;

  await check(checks, "artifacts", "put snapshots bytes", async () => {
    const value = new Uint8Array([1, 2, 3]);
    const pending = store.put(value, {
      mediaType: "application/octet-stream",
    });
    value[0] = 9;
    reference = await pending;
    requireCondition(
      (await store.get(reference))[0] === 1,
      "put retained caller mutation",
    );
  });

  await check(
    checks,
    "artifacts",
    "content address is idempotent",
    async () => {
      requireCondition(reference !== undefined, "first put failed");
      const repeated = await store.put(new Uint8Array([1, 2, 3]), {
        mediaType: "application/octet-stream",
      });
      requireCondition(
        repeated.sha256 === reference.sha256,
        "identical bytes produced different digests",
      );
      requireCondition(await store.has(reference), "stored artifact is absent");
    },
  );

  await check(
    checks,
    "artifacts",
    "reads are isolated and verified",
    async () => {
      requireCondition(reference !== undefined, "first put failed");
      const first = await store.get(reference);
      first[0] = 8;
      requireCondition(
        (await store.get(reference))[0] === 1,
        "read exposed mutable store state",
      );
      let integrityError: unknown;
      try {
        await store.get({ ...reference, bytes: reference.bytes + 1 });
      } catch (error) {
        integrityError = error;
      }
      requireCondition(
        integrityError instanceof ArtifactIntegrityError,
        "mismatched metadata did not fail integrity verification",
      );
    },
  );

  return checks;
}

/** Runs replaceability, identity, and defensive-copy checks. */
export async function checkProjectionStore(
  store: ProjectionStore,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const sessionId = runtime.createId("projection_conformance");
  const snapshot: ProjectionSnapshot<{ total: number }> = {
    name: "conformance",
    version: 1,
    sessionId,
    throughSequence: 0,
    throughEventId: null,
    state: { total: 1 },
  };

  await check(checks, "projections", "save snapshots input", async () => {
    const pending = store.save(snapshot);
    snapshot.state.total = 2;
    await pending;
    const loaded = await store.load<{ total: number }>(
      sessionId,
      "conformance",
      1,
    );
    requireCondition(
      loaded?.state.total === 1,
      "save retained caller mutation",
    );
  });

  await check(checks, "projections", "loads are isolated copies", async () => {
    const loaded = await store.load<{ total: number }>(
      sessionId,
      "conformance",
      1,
    );
    requireCondition(loaded !== null, "saved projection is absent");
    loaded.state.total = 3;
    const again = await store.load<{ total: number }>(
      sessionId,
      "conformance",
      1,
    );
    requireCondition(
      again?.state.total === 1,
      "load exposed mutable store state",
    );
  });

  await check(checks, "projections", "snapshots are replaceable", async () => {
    await store.save({ ...snapshot, state: { total: 4 } });
    const loaded = await store.load<{ total: number }>(
      sessionId,
      "conformance",
      1,
    );
    requireCondition(loaded?.state.total === 4, "replacement was not visible");
  });

  return checks;
}

/** Runs immutable config/descriptor and defensive-copy checks. */
export async function checkSessionCatalog(
  catalog: SessionCatalog,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const config: ImmutableRunConfig = {
    id: runtime.createId("config_conformance"),
    version: 1,
    createdAt: runtime.nowIso(),
    provider: { provider: "conformance", model: "test" },
    tools: [],
    metadata: { value: 1 },
  };
  const session: SessionDescriptor = {
    id: runtime.createId("session_conformance"),
    configId: config.id,
    createdAt: runtime.nowIso(),
    metadata: { value: 1 },
  };

  await check(checks, "sessions", "configs are immutable", async () => {
    const mutable = { ...config, metadata: { value: 1 } };
    const pending = catalog.putConfig(mutable);
    mutable.metadata.value = 9;
    await pending;
    requireCondition(
      (await catalog.getConfig(config.id))?.metadata?.value === 1,
      "config put retained caller mutation",
    );
    await catalog.putConfig({ ...config, metadata: { value: 1 } });
    let conflict: unknown;
    try {
      await catalog.putConfig({
        ...config,
        provider: { provider: "conformance", model: "different" },
      });
    } catch (error) {
      conflict = error;
    }
    requireCondition(conflict instanceof Error, "config conflict was accepted");
  });

  await check(checks, "sessions", "descriptors are immutable", async () => {
    const mutable = { ...session, metadata: { value: 1 } };
    const pending = catalog.putSession(mutable);
    mutable.metadata.value = 9;
    await pending;
    requireCondition(
      (await catalog.getSession(session.id))?.metadata?.value === 1,
      "session put retained caller mutation",
    );
    await catalog.putSession({ ...session, metadata: { value: 1 } });
    let conflict: unknown;
    try {
      await catalog.putSession({ ...session, purpose: "different" });
    } catch (error) {
      conflict = error;
    }
    requireCondition(
      conflict instanceof Error,
      "session conflict was accepted",
    );
  });

  await check(checks, "sessions", "reads are isolated copies", async () => {
    const loadedConfig = await catalog.getConfig(config.id);
    const loadedSession = await catalog.getSession(session.id);
    requireCondition(loadedConfig !== null, "config is absent");
    requireCondition(loadedSession !== null, "session is absent");
    (loadedConfig.metadata as { value: number }).value = 9;
    (loadedSession.metadata as { value: number }).value = 9;
    requireCondition(
      (await catalog.getConfig(config.id))?.metadata?.value === 1,
      "config read exposed mutable store state",
    );
    requireCondition(
      (await catalog.getSession(session.id))?.metadata?.value === 1,
      "session read exposed mutable store state",
    );
  });

  return checks;
}

/**
 * Runs idempotent submission, routing, lease, retry, continuation, and
 * defensive-copy checks against a fresh queue namespace.
 */
export async function checkWorkQueue(
  queue: WorkQueue,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const prefix = runtime.createId("work_conformance");
  const createdAt = runtime.nowIso();
  const item = (
    suffix: string,
    overrides: Partial<WorkItem> = {},
  ): WorkItem => ({
    id: `${prefix}_${suffix}`,
    sessionId: `${prefix}_session_${suffix}`,
    kind: `${prefix}.kind.${suffix}`,
    createdAt,
    requiredCapabilities: [`${prefix}.agent`],
    policy: { maxAttempts: 2, maxContinuations: 1 },
    metadata: { value: 1 },
    ...overrides,
  });

  await check(
    checks,
    "work",
    "enqueue is immutable and idempotent",
    async () => {
      const original = item("enqueue");
      const mutable = {
        ...original,
        metadata: { value: 1 },
      };
      const pending = queue.enqueue(mutable);
      mutable.metadata.value = 9;
      await pending;
      requireCondition(
        (await queue.get(original.id))?.item.metadata?.value === 1,
        "enqueue retained caller mutation",
      );
      await queue.enqueue(original);
      let conflict: unknown;
      try {
        await queue.enqueue({ ...original, kind: `${original.kind}.changed` });
      } catch (error) {
        conflict = error;
      }
      requireCondition(
        conflict instanceof WorkItemConflictError,
        "conflicting enqueue did not throw WorkItemConflictError",
      );
    },
  );

  await check(checks, "work", "claims route and are exclusive", async () => {
    const routed = item("route", {
      requiredCapabilities: [`${prefix}.agent`, `${prefix}.browser`],
    });
    await queue.enqueue(routed);
    const wrong = await queue.claim({
      workerId: `${prefix}_wrong`,
      capabilities: [`${prefix}.agent`],
      kinds: [routed.kind],
      visibilityTimeoutMs: 60_000,
    });
    requireCondition(wrong === null, "capability routing was ignored");
    const competing = await Promise.all(
      [`${prefix}_browser_1`, `${prefix}_browser_2`].map((workerId) =>
        queue.claim({
          workerId,
          capabilities: [`${prefix}.agent`, `${prefix}.browser`],
          kinds: [routed.kind],
          visibilityTimeoutMs: 60_000,
        }),
      ),
    );
    const claimed = competing.filter((lease) => lease !== null);
    requireCondition(
      claimed.length === 1,
      "concurrent claim was not exclusive",
    );
    const lease = claimed[0]!;
    requireCondition(
      (await queue.claim({
        workerId: `${prefix}_second`,
        capabilities: [`${prefix}.agent`, `${prefix}.browser`],
        kinds: [routed.kind],
        visibilityTimeoutMs: 60_000,
      })) === null,
      "leased delivery was claimed again",
    );
    const completed = await queue.complete(lease, { result: { ok: true } });
    requireCondition(
      completed.state === "completed",
      "completion was not terminal",
    );
    let stale: unknown;
    try {
      await queue.complete(lease);
    } catch (error) {
      stale = error;
    }
    requireCondition(
      stale instanceof WorkLeaseConflictError,
      "stale completion did not throw WorkLeaseConflictError",
    );
  });

  await check(checks, "work", "retries exhaust into dead letter", async () => {
    const retry = item("retry");
    await queue.enqueue(retry);
    const first = await queue.claim({
      workerId: `${prefix}_retry_1`,
      capabilities: [`${prefix}.agent`],
      kinds: [retry.kind],
      visibilityTimeoutMs: 60_000,
    });
    requireCondition(first !== null, "first retry delivery was absent");
    requireCondition(
      (
        await queue.fail(first, {
          message: "transient",
          retryable: true,
        })
      ).state === "queued",
      "retryable first failure was not requeued",
    );
    const second = await queue.claim({
      workerId: `${prefix}_retry_2`,
      capabilities: [`${prefix}.agent`],
      kinds: [retry.kind],
      visibilityTimeoutMs: 60_000,
    });
    requireCondition(second !== null, "second retry delivery was absent");
    requireCondition(second.attempt === 2, "delivery attempt did not advance");
    requireCondition(
      (
        await queue.fail(second, {
          message: "still broken",
          retryable: true,
        })
      ).state === "dead_lettered",
      "retry exhaustion did not dead-letter work",
    );
  });

  await check(
    checks,
    "work",
    "continuations reset delivery attempts and are bounded",
    async () => {
      const continuation = item("continuation");
      await queue.enqueue(continuation);
      const first = await queue.claim({
        workerId: `${prefix}_continuation_1`,
        capabilities: [`${prefix}.agent`],
        kinds: [continuation.kind],
        visibilityTimeoutMs: 60_000,
      });
      requireCondition(
        first !== null,
        "first continuation delivery was absent",
      );
      const queued = await queue.checkpoint(first, {
        reason: "bounded host deadline",
      });
      requireCondition(
        queued.state === "queued",
        "checkpoint was not requeued",
      );
      requireCondition(
        queued.attempt === 0,
        "checkpoint did not reset attempts",
      );
      requireCondition(
        queued.continuationCount === 1,
        "continuation counter did not advance",
      );
      const second = await queue.claim({
        workerId: `${prefix}_continuation_2`,
        capabilities: [`${prefix}.agent`],
        kinds: [continuation.kind],
        visibilityTimeoutMs: 60_000,
      });
      requireCondition(second !== null, "continued delivery was absent");
      requireCondition(
        (await queue.checkpoint(second, { reason: "limit" })).state ===
          "dead_lettered",
        "continuation exhaustion did not dead-letter work",
      );
    },
  );

  return checks;
}

/**
 * Runs exclusivity and stale-writer fencing checks. Distributed adapters must
 * enforce the token in the same transaction as append.
 */
export async function checkFencedJournalStore(
  journal: FencedJournalStore,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const sessionId = runtime.createId("execution_conformance");
  const firstOwner = runtime.createId("worker");
  const secondOwner = runtime.createId("worker");
  let replacementOwner = secondOwner;
  let firstLease:
    | Awaited<ReturnType<FencedJournalStore["acquireExecutionLease"]>>
    | undefined;
  let currentLease:
    | Awaited<ReturnType<FencedJournalStore["acquireExecutionLease"]>>
    | undefined;

  await check(
    checks,
    "execution",
    "execution ownership is exclusive",
    async () => {
      const competing = await Promise.all(
        [firstOwner, secondOwner].map((ownerId) =>
          journal.acquireExecutionLease({
            sessionId,
            ownerId,
            durationMs: 60_000,
          }),
        ),
      );
      const acquired = competing.filter((lease) => lease !== null);
      requireCondition(
        acquired.length === 1,
        "concurrent execution lease acquisition was not exclusive",
      );
      firstLease = acquired[0]!;
      replacementOwner =
        firstLease.ownerId === firstOwner ? secondOwner : firstOwner;
    },
  );

  await check(
    checks,
    "execution",
    "fenced append rejects old owner",
    async () => {
      requireCondition(firstLease != null, "first lease was not acquired");
      const firstView = bindExecutionLease(journal, firstLease);
      await firstView.append(
        sessionId,
        {
          category: "control",
          type: "conformance.execution.first",
          data: {},
        },
        { expectedHeadId: null },
      );
      await journal.releaseExecutionLease(firstLease);
      const secondLease = await journal.acquireExecutionLease({
        sessionId,
        ownerId: replacementOwner,
        durationMs: 60_000,
      });
      requireCondition(
        secondLease !== null,
        "second owner could not acquire lease",
      );
      requireCondition(
        secondLease.fencingToken > firstLease.fencingToken,
        "fencing token did not increase",
      );
      let stale: unknown;
      try {
        await firstView.append(sessionId, {
          category: "trace",
          type: "conformance.execution.stale",
          data: {},
        });
      } catch (error) {
        stale = error;
      }
      requireCondition(
        stale instanceof ExecutionLeaseConflictError,
        "stale writer did not throw ExecutionLeaseConflictError",
      );
      await bindExecutionLease(journal, secondLease).append(sessionId, {
        category: "control",
        type: "conformance.execution.second",
        data: {},
      });
      const events = await journal.read(sessionId);
      validateChain(sessionId, events);
      requireCondition(events.length === 2, "stale writer changed the journal");
      currentLease = secondLease;
    },
  );

  await check(
    checks,
    "execution",
    "fenced append honors expected head",
    async () => {
      requireCondition(currentLease != null, "current lease is absent");
      let conflict: unknown;
      try {
        await journal.appendFenced(
          sessionId,
          { category: "trace", type: "conformance.execution.cas", data: {} },
          currentLease,
          { expectedHeadId: null },
        );
      } catch (error) {
        conflict = error;
      }
      requireCondition(
        conflict instanceof JournalConflictError,
        "stale expectedHeadId on a fenced append did not throw JournalConflictError",
      );
      requireCondition(
        (await journal.read(sessionId)).length === 2,
        "conflicting fenced append changed the journal",
      );
    },
  );

  await check(checks, "execution", "expired lease cannot append", async () => {
    const expirySessionId = runtime.createId("execution_conformance");
    const lease = await journal.acquireExecutionLease({
      sessionId: expirySessionId,
      ownerId: runtime.createId("worker"),
      durationMs: 1,
    });
    requireCondition(lease !== null, "short lease could not be acquired");
    // Expiry fencing can only be observed on an advancing adapter clock.
    const deadline = Date.now() + 2_000;
    while (Date.parse(runtime.nowIso()) <= Date.parse(lease.expiresAt)) {
      requireCondition(
        Date.now() < deadline,
        "runtime clock did not advance past lease expiry; expiry fencing could not be verified",
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let stale: unknown;
    try {
      await journal.appendFenced(
        expirySessionId,
        { category: "trace", type: "conformance.execution.expired", data: {} },
        lease,
      );
    } catch (error) {
      stale = error;
    }
    requireCondition(
      stale instanceof ExecutionLeaseConflictError,
      "expired lease append did not throw ExecutionLeaseConflictError",
    );
    requireCondition(
      (await journal.read(expirySessionId)).length === 0,
      "expired writer changed the journal",
    );
  });

  return checks;
}

export interface CheckOrchestrationOptions {
  adapter: string;
  queue: WorkQueue;
  journal?: FencedJournalStore;
  runtime?: RuntimeServices;
}

/**
 * Run against fresh adapter namespaces. Checks intentionally create work,
 * leases, and journal events.
 */
export async function checkOrchestration(
  options: CheckOrchestrationOptions,
): Promise<OrchestrationConformanceReport> {
  const runtime = options.runtime ?? defaultRuntime;
  const checks = await checkWorkQueue(options.queue, runtime);
  if (options.journal !== undefined) {
    checks.push(...(await checkFencedJournalStore(options.journal, runtime)));
  }
  return {
    adapter: options.adapter,
    passed: checks.every((item) => item.passed),
    checks,
  };
}

/**
 * Run against a fresh adapter namespace. The checks intentionally write test
 * records and are suitable for CI, staging, or disposable local stores.
 */
export async function checkHarnessStorage(
  storage: HarnessStorage,
  runtime: RuntimeServices = defaultRuntime,
): Promise<StorageConformanceReport> {
  const checks: ConformanceCheck[] = [];
  await check(checks, "profile", "profile is explicit", () => {
    requireCondition(storage.profile.name.length > 0, "profile name is empty");
    for (const [name, profile] of Object.entries({
      journal: storage.profile.journal,
      artifacts: storage.profile.artifacts,
      projections: storage.profile.projections,
      sessions: storage.profile.sessions,
    })) {
      requireCondition(profile.adapter.length > 0, `${name} adapter is empty`);
      requireCondition(
        ["ephemeral", "durable"].includes(profile.durability),
        `${name} durability is invalid`,
      );
      requireCondition(
        [
          "single_instance",
          "single_process",
          "multi_process",
          "distributed",
        ].includes(profile.coordination),
        `${name} coordination is invalid`,
      );
    }
  });
  checks.push(
    ...(await checkRuntimeServices(runtime)),
    ...(await checkJournalStore(storage.journal, runtime)),
    ...(await checkArtifactStore(storage.artifacts)),
    ...(await checkProjectionStore(storage.projections, runtime)),
    ...(await checkSessionCatalog(storage.sessions, runtime)),
  );
  return {
    adapter: storage.profile.name,
    passed: checks.every((item) => item.passed),
    checks,
  };
}

export function assertStorageConformance(
  report: StorageConformanceReport,
): void {
  if (!report.passed) throw new StorageConformanceError(report);
}

export function assertOrchestrationConformance(
  report: OrchestrationConformanceReport,
): void {
  if (!report.passed) throw new OrchestrationConformanceError(report);
}
