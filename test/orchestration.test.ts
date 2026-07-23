import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOrchestrationConformance,
  bindExecutionLease,
  checkOrchestration,
  createMemoryStorage,
  createSessionRunWork,
  defaultRuntime,
  ExecutionLeaseConflictError,
  MemoryFencedJournalStore,
  MemorySessionCatalog,
  MemoryWorkQueue,
  runAgentLoop,
  SessionManager,
  SessionWorkDispatcher,
  WorkItemConflictError,
  WorkLeaseConflictError,
  WorkerHost,
  type ImmutableRunConfig,
  type RuntimeServices,
  type WorkItem,
} from "../src/index.js";

function manualRuntime(start = "2026-01-01T00:00:00.000Z"): {
  runtime: RuntimeServices;
  advance(milliseconds: number): void;
} {
  let current = Date.parse(start);
  let next = 0;
  return {
    runtime: {
      createId(prefix) {
        next += 1;
        return `${prefix ?? "id"}_${next}`;
      },
      nowIso() {
        return new Date(current).toISOString();
      },
      sha256(value) {
        return defaultRuntime.sha256(value);
      },
    },
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}

function work(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    sessionId: `session_${id}`,
    kind: "agent.run",
    createdAt: "2026-01-01T00:00:00.000Z",
    requiredCapabilities: ["agent"],
    policy: { maxAttempts: 2, maxContinuations: 1 },
    ...overrides,
  };
}

test("work queue routes capabilities and enforces immutable enqueue", async () => {
  const clock = manualRuntime();
  const queue = new MemoryWorkQueue(clock.runtime);
  const browser = work("browser", {
    requiredCapabilities: ["agent", "browser"],
    priority: 10,
  });
  const code = work("code", {
    requiredCapabilities: ["agent", "code"],
  });
  await queue.enqueue(browser);
  const first = await queue.enqueue(code);
  first.item.kind = "mutated";
  assert.equal((await queue.get(code.id))?.item.kind, "agent.run");
  assert.equal((await queue.enqueue(code)).state, "queued");
  await assert.rejects(
    queue.enqueue({ ...code, kind: "other" }),
    WorkItemConflictError,
  );

  const codeLease = await queue.claim({
    workerId: "code-worker",
    capabilities: ["agent", "code"],
    kinds: ["agent.run"],
    visibilityTimeoutMs: 1_000,
  });
  assert.equal(codeLease?.item.id, code.id);

  const browserLease = await queue.claim({
    workerId: "browser-worker",
    capabilities: ["agent", "browser"],
    kinds: ["agent.run"],
    visibilityTimeoutMs: 1_000,
  });
  assert.equal(browserLease?.item.id, browser.id);
});

test("memory execution ports satisfy reusable orchestration conformance", async () => {
  const clock = manualRuntime();
  const report = await checkOrchestration({
    adapter: "memory",
    queue: new MemoryWorkQueue(clock.runtime),
    journal: new MemoryFencedJournalStore(clock.runtime),
    runtime: clock.runtime,
  });
  assertOrchestrationConformance(report);
  assert.equal(report.passed, true);
});

test("work queue separates retries, continuations, and stale deliveries", async () => {
  const clock = manualRuntime();
  const queue = new MemoryWorkQueue(clock.runtime);
  await queue.enqueue(work("retry"));

  const first = await queue.claim({
    workerId: "worker-a",
    capabilities: ["agent"],
    visibilityTimeoutMs: 1_000,
  });
  assert.ok(first);
  assert.equal(
    (
      await queue.fail(first, {
        message: "transient",
        retryable: true,
      })
    ).state,
    "queued",
  );
  const second = await queue.claim({
    workerId: "worker-b",
    capabilities: ["agent"],
    visibilityTimeoutMs: 1_000,
  });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.equal(
    (
      await queue.fail(second, {
        message: "still broken",
        retryable: true,
      })
    ).state,
    "dead_lettered",
  );

  await queue.enqueue(work("continuation"));
  const segmentOne = await queue.claim({
    workerId: "worker-a",
    capabilities: ["agent"],
    visibilityTimeoutMs: 1_000,
  });
  assert.ok(segmentOne);
  const resumed = await queue.checkpoint(segmentOne, {
    reason: "host deadline approaching",
    checkpointEventId: "evt_10",
  });
  assert.equal(resumed.state, "queued");
  assert.equal(resumed.attempt, 0);
  assert.equal(resumed.continuationCount, 1);
  const segmentTwo = await queue.claim({
    workerId: "worker-b",
    capabilities: ["agent"],
    visibilityTimeoutMs: 1_000,
  });
  assert.ok(segmentTwo);
  assert.equal(
    (
      await queue.checkpoint(segmentTwo, {
        reason: "another deadline",
      })
    ).state,
    "dead_lettered",
  );

  await queue.enqueue(work("stale"));
  const stale = await queue.claim({
    workerId: "worker-a",
    capabilities: ["agent"],
    visibilityTimeoutMs: 100,
  });
  assert.ok(stale);
  clock.advance(101);
  const replacement = await queue.claim({
    workerId: "worker-b",
    capabilities: ["agent"],
    visibilityTimeoutMs: 100,
  });
  assert.ok(replacement);
  assert.ok(replacement.fencingToken > stale.fencingToken);
  await assert.rejects(queue.complete(stale), WorkLeaseConflictError);
  assert.equal((await queue.complete(replacement)).state, "completed");
});

test("fenced journals reject an expired writer after ownership changes", async () => {
  const clock = manualRuntime();
  const journal = new MemoryFencedJournalStore(clock.runtime);
  const first = await journal.acquireExecutionLease({
    sessionId: "session",
    ownerId: "worker-a",
    durationMs: 100,
  });
  assert.ok(first);
  assert.equal(
    await journal.acquireExecutionLease({
      sessionId: "session",
      ownerId: "worker-b",
      durationMs: 100,
    }),
    null,
  );

  const firstView = bindExecutionLease(journal, first);
  await firstView.append("session", {
    category: "control",
    type: "run.started",
    data: {},
  });
  clock.advance(101);
  const second = await journal.acquireExecutionLease({
    sessionId: "session",
    ownerId: "worker-b",
    durationMs: 100,
  });
  assert.ok(second);
  assert.ok(second.fencingToken > first.fencingToken);
  await assert.rejects(
    firstView.append("session", {
      category: "trace",
      type: "stale.write",
      data: {},
    }),
    ExecutionLeaseConflictError,
  );
  await bindExecutionLease(journal, second).append("session", {
    category: "control",
    type: "run.resumed",
    data: {},
  });
  assert.deepEqual(
    (await journal.read("session")).map((event) => event.type),
    ["run.started", "run.resumed"],
  );
});

test("a Claude manager can fork and idempotently dispatch provider-neutral workers", async () => {
  const clock = manualRuntime();
  const storage = createMemoryStorage(clock.runtime);
  const sessions = new SessionManager(
    storage.journal,
    storage.sessions,
    clock.runtime,
  );
  const managerConfig: ImmutableRunConfig = {
    id: "manager-config",
    version: 1,
    createdAt: clock.runtime.nowIso(),
    provider: { provider: "anthropic", model: "claude-manager" },
    tools: [],
  };
  const workerConfig: ImmutableRunConfig = {
    id: "browser-worker-config",
    version: 1,
    createdAt: clock.runtime.nowIso(),
    provider: { provider: "openai", model: "worker-model" },
    tools: [],
  };
  const manager = await sessions.create(managerConfig, {
    id: "manager-session",
  });
  const queue = new MemoryWorkQueue(clock.runtime);
  const dispatcher = new SessionWorkDispatcher(sessions, queue);
  const dispatched = await dispatcher.forkAndDispatch(
    manager.id,
    workerConfig,
    { id: "child-session", purpose: "Use a remote browser" },
    { requiredCapabilities: ["agent", "browser"] },
  );

  assert.equal(dispatched.work.item.sessionId, "child-session");
  assert.deepEqual(dispatched.work.item.requiredCapabilities, [
    "agent",
    "browser",
  ]);
  assert.equal(
    (dispatched.work.item.payload as { configId: string }).configId,
    workerConfig.id,
  );
  const repeated = await dispatcher.dispatch("child-session", {
    requiredCapabilities: ["agent", "browser"],
  });
  assert.equal(repeated.work.item.id, dispatched.work.item.id);
  assert.deepEqual(
    createSessionRunWork(dispatched.session, {
      requiredCapabilities: ["agent", "browser"],
    }),
    repeated.work.item,
  );

  const repeatedFork = await dispatcher.forkAndDispatch(
    manager.id,
    workerConfig,
    { id: "child-session", purpose: "Use a remote browser" },
    { requiredCapabilities: ["agent", "browser"] },
  );
  assert.equal(repeatedFork.session.createdAt, dispatched.session.createdAt);
  assert.equal(repeatedFork.work.item.id, dispatched.work.item.id);
  assert.equal(
    (await storage.journal.read(manager.id)).filter(
      (event) => event.type === "child.started",
    ).length,
    1,
  );
});

test("stable child IDs recover a fork interrupted before journal handoff", async () => {
  const clock = manualRuntime();
  const storage = createMemoryStorage(clock.runtime);
  const sessions = new SessionManager(
    storage.journal,
    storage.sessions,
    clock.runtime,
  );
  const managerConfig: ImmutableRunConfig = {
    id: "manager",
    version: 1,
    createdAt: clock.runtime.nowIso(),
    provider: { provider: "anthropic", model: "manager" },
    tools: [],
  };
  const childConfig: ImmutableRunConfig = {
    id: "child",
    version: 1,
    createdAt: clock.runtime.nowIso(),
    provider: { provider: "openai", model: "worker" },
    tools: [],
  };
  const manager = await sessions.create(managerConfig, { id: "manager" });
  const forkEventId = (await storage.journal.head(manager.id))!.id;
  await storage.sessions.putConfig(childConfig);
  await storage.sessions.putSession({
    id: "recoverable-child",
    configId: childConfig.id,
    createdAt: clock.runtime.nowIso(),
    parentSessionId: manager.id,
    forkEventId,
    purpose: "Recover me",
  });

  const dispatcher = new SessionWorkDispatcher(
    sessions,
    new MemoryWorkQueue(clock.runtime),
  );
  const recovered = await dispatcher.forkAndDispatch(manager.id, childConfig, {
    id: "recoverable-child",
    purpose: "Recover me",
  });
  assert.equal(recovered.work.state, "queued");
  assert.equal(
    (await storage.journal.read("recoverable-child"))[0]?.type,
    "session.started",
  );
  assert.equal(
    (await storage.journal.read(manager.id)).at(-1)?.type,
    "child.started",
  );
});

test("worker host performs one bounded delivery and can heartbeat", async () => {
  const clock = manualRuntime();
  const queue = new MemoryWorkQueue(clock.runtime);
  await queue.enqueue(work("host"));
  const host = new WorkerHost({
    queue,
    workerId: "worker",
    capabilities: ["agent"],
    visibilityTimeoutMs: 100,
    handlers: {
      "agent.run": {
        async handle(item, context) {
          const renewed = await context.heartbeat(200);
          assert.equal(renewed.item.id, item.id);
          return { status: "completed", result: { ok: true } };
        },
      },
    },
  });
  const outcome = await host.runOne();
  assert.equal(outcome.status, "processed");
  assert.equal(
    outcome.status === "processed" ? outcome.record.state : null,
    "completed",
  );
  assert.deepEqual(
    outcome.status === "processed" ? outcome.record.completion?.result : null,
    { ok: true },
  );
  assert.deepEqual(await host.runOne(), { status: "idle" });
});

test("distributed worker composition renews both leases and runs through a fenced journal", async () => {
  const clock = manualRuntime();
  const journal = new MemoryFencedJournalStore(clock.runtime);
  const catalog = new MemorySessionCatalog();
  const sessions = new SessionManager(journal, catalog, clock.runtime);
  const config: ImmutableRunConfig = {
    id: "distributed-config",
    version: 1,
    createdAt: clock.runtime.nowIso(),
    provider: { provider: "anthropic", model: "worker" },
    tools: [],
  };
  const session = await sessions.create(config, {
    id: "distributed-session",
  });
  const queue = new MemoryWorkQueue(clock.runtime);
  await new SessionWorkDispatcher(sessions, queue).dispatch(session.id);

  const host = new WorkerHost({
    queue,
    workerId: "machine-a",
    capabilities: ["agent"],
    visibilityTimeoutMs: 1_000,
    handlers: {
      "agent.run": {
        async handle(item, context) {
          const acquired = await journal.acquireExecutionLease({
            sessionId: item.sessionId,
            ownerId: context.workerId,
            durationMs: 1_000,
          });
          assert.ok(acquired);
          let executionLease = acquired;
          const outcome = await runAgentLoop({
            sessionId: item.sessionId,
            config,
            journal: bindExecutionLease(journal, executionLease),
            project: () => sessions.project(item.sessionId),
            model: {
              async invoke() {
                return {
                  message: {
                    id: clock.runtime.createId("msg"),
                    role: "assistant",
                    createdAt: clock.runtime.nowIso(),
                    content: [{ type: "text", text: "done" }],
                  },
                  telemetry: {
                    provider: "anthropic",
                    model: "worker",
                    latencyMs: 1,
                    usage: { inputTokens: 1, outputTokens: 1 },
                    stopReason: "end",
                  },
                };
              },
            },
            actions: {
              async execute() {
                throw new Error("no action expected");
              },
            },
            runtime: clock.runtime,
            beforeTurn: async () => {
              await context.heartbeat();
              executionLease = await journal.renewExecutionLease(
                executionLease,
                1_000,
              );
            },
          });
          await journal.releaseExecutionLease(executionLease);
          return { status: "completed", result: outcome };
        },
      },
    },
  });

  const result = await host.runOne();
  assert.equal(
    result.status === "processed" ? result.record.state : null,
    "completed",
  );
  assert.deepEqual(
    (await journal.read(session.id)).map((event) => event.type),
    [
      "session.started",
      "model.call.started",
      "model.call.completed",
      "message.appended",
      "run.completed",
    ],
  );
});

test("agent loop can checkpoint before a serverless host deadline", async () => {
  const clock = manualRuntime();
  const storage = createMemoryStorage(clock.runtime);
  const outcome = await runAgentLoop({
    sessionId: "session",
    config: {
      id: "config",
      version: 1,
      createdAt: clock.runtime.nowIso(),
      provider: { provider: "test", model: "test" },
      tools: [],
    },
    journal: storage.journal,
    model: {
      async invoke() {
        throw new Error("model must not be called");
      },
    },
    actions: {
      async execute() {
        throw new Error("actions must not be called");
      },
    },
    runtime: clock.runtime,
    shouldCheckpoint: () => "host deadline approaching",
  });
  assert.deepEqual(outcome, {
    status: "checkpointed",
    turns: 0,
    reason: "host deadline approaching",
  });
});
