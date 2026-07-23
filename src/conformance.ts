import { ArtifactIntegrityError, type ArtifactStore } from "./artifacts.js";
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

export interface ConformanceCheck {
  scope:
    | "profile"
    | "runtime"
    | "journal"
    | "artifacts"
    | "projections"
    | "sessions";
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
