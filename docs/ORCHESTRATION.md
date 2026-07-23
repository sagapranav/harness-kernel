# Orchestration and deployment

Harness Kernel separates the durable **semantic plane** from the replaceable
**execution plane**. That separation is what lets the same agent design run:

- inside one foreground CLI process;
- as a manager plus local worker pool;
- across worker processes or machines;
- behind a stateless API and managed queue;
- in bounded serverless invocations that checkpoint and continue.

The model provider, worker topology, browser host, queue, database, and object
store can all change without changing the canonical message or journal schema.

## The two planes

```text
                         CONTROL / EXECUTION PLANE

 request ──→ API or CLI ──→ WorkQueue ──→ WorkerHost ──→ browser/sandbox/tools
              │                │              │
              │          retry, lease,        ├─ queue heartbeat
              │          continuation,        └─ execution lease + fence
              │          dead letter
              │
              ▼
                         DURABLE SEMANTIC PLANE

        SessionCatalog ──→ JournalStore ──→ projections / audit / evals
               │                │
               └──────────────→ ArtifactStore
```

The queue answers “where and when should this run?” The journal answers “what
happened in the agent?” Do not make one impersonate the other:

- queue delivery attempts, visibility timeouts, and dead-letter state are
  operational scheduling facts;
- canonical messages, model responses, action receipts, evidence, and run
  outcomes are semantic history;
- a queue may be replaced without rewriting session journals;
- projections may be rebuilt without replaying external effects.

## Mapping a production browser-agent architecture

The Browser Use production design is an API → SQS → Lambda architecture. It
creates durable task/session records, returns HTTP 202, lets a queue invoke
stateless workers, checkpoints agent state to object storage, and re-enqueues
continuations before Lambda's hard deadline.

| Production component     | Harness Kernel contract                                  | Typical adapter                                 |
| ------------------------ | -------------------------------------------------------- | ----------------------------------------------- |
| API task acceptance      | application code + `SessionManager`                      | HTTP service, CLI, webhook                      |
| Durable task queue       | `WorkQueue`                                              | SQS, Redis, Postgres, Kafka, cloud task service |
| Queue-triggered worker   | `WorkerHost.runOne()`                                    | Lambda handler, container, process, VM          |
| Task/model settings      | immutable `WorkItem` references + `ImmutableRunConfig`   | queue payload + session catalog                 |
| Agent checkpoint         | append-only `JournalStore`                               | Postgres, transactional KV, durable service     |
| Screenshots and files    | `ArtifactStore`                                          | S3, R2, GCS, filesystem                         |
| Final task row           | queue completion + cold projection                       | SQL table or materialized projection            |
| Visibility timeout       | `WorkLease`                                              | native queue lease/receipt handle               |
| Retry and DLQ            | `WorkDeliveryPolicy` + queue transition                  | native queue metadata and DLQ                   |
| Lambda continuation      | `runAgentLoop.shouldCheckpoint` + `WorkQueue.checkpoint` | new queue message or state transition           |
| Exclusive session writer | `FencedJournalStore`                                     | database lease row + transactional fence        |

The kernel does not require AWS. An SQS adapter should let SQS own delivery
attempts and DLQ movement rather than copying those counters into the session
journal. A Postgres queue adapter may own the same facts in rows.

Some managed queues do not natively provide immutable enqueue, arbitrary
`get(workId)`, or an atomic “checkpoint old message into new message” operation.
Such an adapter may pair the managed queue with a durable work-record table.
Duplicate delivery is still possible; the table, deterministic work ID,
execution fence, and action idempotency make it harmless. Do not claim the
managed queue alone supplies semantics it does not have.

## Work items

`WorkItem` is a durable execution reference:

```ts
interface WorkItem {
  id: string;
  sessionId: string;
  kind: string;
  createdAt: string;
  requiredCapabilities: string[];
  policy: {
    maxAttempts: number;
    maxContinuations: number;
  };
  payload?: unknown;
  priority?: number;
  notBefore?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}
```

`createSessionRunWork()` builds this shape for an agent session with a
deterministic `session:<id>:run` work ID; `DEFAULT_AGENT_WORK_POLICY` allows 3
attempts per segment and 12 continuations.

Keep queue payloads small. Put immutable config IDs, session IDs, artifact
references, and routing metadata in them. Do not put credentials, complete
prompts, browser cookies, or a whole journal in a queue message. Workers load
durable state after claiming work and obtain credentials from the deployment's
secret boundary.

Every new delivery receives a higher fencing token. The delivery attempt
counter and continuation counter mean different things:

- an **attempt** repeats the same segment after infrastructure or handler
  failure;
- a **continuation** starts a new segment after a successful, durable
  checkpoint, such as stopping before a serverless deadline.

Conflating them makes long valid runs look like flaky retries and makes retry
limits accidentally cap total task duration.

## Manager sessions on any provider

A manager is an ordinary session whose action surface includes a spawn action.
Which model runs it — Claude, an OpenAI model, or anything behind an adapter —
is configuration, not an orchestration primitive:

```ts
const managerConfig = {
  id: "manager-v1",
  version: 1,
  createdAt: runtime.nowIso(),
  provider: { provider: "anthropic", model: "your-manager-model" },
  tools: [spawnAgentTool],
};
```

The spawn action adapter calls `SessionWorkDispatcher.forkAndDispatch()`:

```ts
const dispatcher = new SessionWorkDispatcher(sessions, queue);

const child = await dispatcher.forkAndDispatch(
  managerSession.id,
  browserWorkerConfig,
  {
    id: stableChildSessionId,
    purpose: "Collect evidence from the account portal",
  },
  { requiredCapabilities: ["agent", "browser"] },
);
```

This creates a first-class child journal and submits one capability-routed work
item. The child may use OpenAI, Anthropic, or another provider independently of
the manager. When it finishes, application code calls
`SessionManager.completeChild()` with the small conclusion and evidence
references. The parent sees that result as one model-visible observation; it
does not inherit the child's full search trace.

For a consequential spawn action, derive `stableChildSessionId` from its
idempotency key. `forkAndDispatch()` can then recover a descriptor written
before a crash, repair missing child/parent start events, and finish dispatch.
The default work ID is derived from the session ID and the work creation time is
the immutable session creation time. Repeating the operation is therefore
idempotent.

### The creation/enqueue gap

Session creation and queue submission usually live in different systems. There
is no universal transaction across Postgres and SQS.

Use one of these patterns:

1. For a local CLI, perform both calls in one process and retry `dispatch()`
   using the deterministic work ID.
2. For a database-backed API, write a transactional outbox row beside the
   session record, then let an outbox relay enqueue it idempotently.
3. For a workflow engine, let the engine record the completed session-creation
   step and retry only the queue step.

Never generate a fresh work ID on every retry. That converts a recovery retry
into duplicate agent execution.

## Workers on one or many machines

`WorkerHost` handles one bounded delivery. A service, CLI, Lambda handler, or
container supervisor owns polling and concurrency:

```ts
const host = new WorkerHost({
  queue,
  workerId: machineAndProcessId,
  capabilities: ["agent", "browser"],
  visibilityTimeoutMs: 60_000,
  handlers: {
    "agent.run": agentRunHandler,
  },
});

const result = await host.runOne();
```

Workers advertise capabilities. A browser worker can run on a browser-equipped
machine, a coding worker in a sandbox pool, and a research worker in another
region. They consume the same work format.

`runOne()` resolves to `idle`, `processed`, or `lease_lost`. `lease_lost`
means the visibility lease expired or was superseded before the handler's
resolution could be acknowledged: the queue will redeliver, the handler's
journal writes are preserved, and the next delivery reconciles from durable
history. Hosts should log it, not crash on it.

The reference host deliberately runs at most one delivery. This keeps process
lifecycle and backpressure out of the portable core:

- a foreground CLI may call it until the queue is empty;
- a daemon may poll with bounded concurrency;
- Lambda invokes it once per queue event;
- Kubernetes scales replicas from queue depth;
- a workflow activity may call it for one recorded step.

Do not implement polling with an unbounded in-memory `Promise.all`. Concurrency
must respect browser capacity, model rate limits, memory, and downstream
authority limits.

## Queue leases are necessary but not sufficient

A visibility lease prevents normal duplicate delivery. It does not prove that
an expired worker has stopped. Network partitions, event-loop stalls, and
process pauses can leave the old worker alive while a replacement begins.

That is why the kernel also exposes `FencedJournalStore`:

```ts
const executionLease = await journal.acquireExecutionLease({
  sessionId: item.sessionId,
  ownerId: context.workerId,
  durationMs: 60_000,
});

if (executionLease === null) {
  return {
    status: "failed",
    message: "session already has an active writer",
    retryable: true,
  };
}

const fencedJournal = bindExecutionLease(journal, executionLease);
```

Pass `fencedJournal` to `runAgentLoop()`. A distributed implementation must
check the fencing token in the same transaction as the append. A separate
“is my lease valid?” request followed by an ordinary append has a race and is
not a valid implementation.

The loop adds a second, independent defense: every append it makes is an
expected-head compare-and-append against the head it last observed. If another
writer interleaves an event, the loop's next append throws
`JournalConflictError` and the loop stops writing — including the run outcome.
Handlers should treat that exception (and `ExecutionLeaseConflictError` from a
lost session lease) as lost ownership and return a retryable failure; the
journal stays linear and the next delivery recovers from durable history.

Before every turn, renew both layers:

```ts
let sessionLease = executionLease;

const outcome = await runAgentLoop({
  sessionId: item.sessionId,
  config,
  journal: fencedJournal,
  model,
  actions,
  project: () => sessions.project(item.sessionId),
  beforeTurn: async () => {
    await context.heartbeat();
    sessionLease = await journal.renewExecutionLease(sessionLease, 60_000);
  },
  shouldCheckpoint: () =>
    timeRemainingMs() < 120_000 ? "host deadline approaching" : null,
});
```

Use a monotonic host clock to compute `timeRemainingMs()`. Wall-clock ISO time
in `RuntimeServices` is for durable timestamps, not precision deadline
measurement.

## Continuation and resume

The journal is already a step-level recovery boundary because the loop appends
each model observation and action receipt before it can influence the next
turn. A serverless worker can:

1. detect that its safety margin has been reached;
2. let `runAgentLoop()` append a `checkpointed` run outcome;
3. get the current journal head ID;
4. return a `checkpointed` `WorkResolution` with that event ID;
5. let the queue increment the continuation count and make the item available;
6. let another worker restore config/context from durable storage and resume.

Do not auto-continue every checkpoint reason. A host deadline or bounded turn
slice is normally resumable. An unknown action postcondition requires
reconciliation: give `runAgentLoop()` a `reconcileAction` hook that checks the
external postcondition and returns a terminal receipt, or record one out of
band with `appendActionReconciliation()`. Blindly requeueing an unreconciled
checkpoint burns the continuation budget without resolving the effect.

The loop repairs the other crash boundaries on startup by itself: it executes
tool calls that were journaled but never started, marks and re-invokes model
calls whose response was lost, and replays a finished turn's lost outcome.
Transient provider failures can be retried inside a delivery with the
`modelRetryDelayMs` loop option instead of consuming a queue attempt.

The application owns this mapping because it knows which failures are safe to
retry:

| Loop outcome                    | Usual queue resolution                             |
| ------------------------------- | -------------------------------------------------- |
| `completed`                     | `completed`                                        |
| `limited`                       | `checkpointed`, if a bounded slice was intentional |
| deadline checkpoint             | `checkpointed`                                     |
| unresolved action checkpoint    | pause for reconciliation                           |
| transient model/network failure | retryable `failed`                                 |
| policy refusal or invalid task  | non-retryable `failed`                             |
| cancelled                       | `cancelled`                                        |

## Action idempotency under at-least-once delivery

Exactly-once external effects are not available merely because queue
acknowledgement is atomic. A worker can perform an external operation and die
before recording the receipt.

Consequential action adapters must use the existing
`ActionInvocation.idempotencyKey`, retain an external operation ID, and query
the expected postcondition after ambiguous failure. The loop records
`pending`/`unknown` and checkpoints rather than guessing.

Fencing protects journal ownership. Idempotency and postcondition checks protect
the world outside the journal. Both are required.

## Browser and sandbox lifecycles

Browser Use, Browserbase, a local Playwright process, or a custom remote browser
service belongs behind the action executor or a worker-scoped resource
factory. The canonical loop should not know which one is used.

For every delivery:

1. create a session-specific workspace;
2. provision or reconnect the external browser/sandbox;
3. expose only the credentials and authority that work item needs;
4. record external session IDs in action receipts or trace metadata;
5. offload screenshots/downloads through `ArtifactStore`;
6. close resources in `finally`;
7. wipe ephemeral workspace state before it can be reused.

Warm workers are not clean workers. A reused `/tmp`, browser profile, cookie
jar, or download directory can leak data between sessions.

## Storage can vary by state class

A deployment does not need one database:

| State                       | Correctness requirement                    | Common backing                            |
| --------------------------- | ------------------------------------------ | ----------------------------------------- |
| Session descriptors/configs | immutable, durable                         | Postgres, transactional KV                |
| Raw journal                 | durable, linear, conditional/fenced append | Postgres, durable actor, transactional KV |
| Artifact outputs/downloads  | durable, integrity checked                 | S3, R2, GCS                               |
| Screenshots/debug frames    | often best effort                          | object store with lifecycle policy        |
| Cold projections/search     | rebuildable                                | SQL tables, Redis, search index           |
| Queue state                 | atomic leases, retry/DLQ semantics         | SQS, Redis, Postgres, cloud task queue    |
| Ephemeral workspace         | isolated, disposable                       | container disk, VM disk, temp directory   |
| Secrets                     | scoped and revocable                       | secret manager, workload identity         |

The current `HarnessStorage` profile is per port for this reason. If screenshots
and durable outputs need different retention or reliability, route artifact
puts by application policy to two `ArtifactStore` adapters while retaining the
same content-addressed references.

Never make journal progress depend on a best-effort screenshot upload. Never
label the journal best effort.

## Deployment compositions

### One CLI, one process

- `MemoryWorkQueue`
- `createMemoryStorage()` for disposable runs, or a durable local storage
  adapter
- one manager loop and one or more `WorkerHost` instances
- in-process model/action adapters

This is the smallest packaging. The CLI is an assembly layer; it does not need a
different protocol.

### Durable local CLI

- a SQLite or transactional local queue adapter
- SQLite journal/catalog/projections
- filesystem artifact store
- process-scoped workers

The package does not currently ship a SQLite queue. Implement the ports, run
the conformance suites, and keep the CLI composition unchanged.

### Multi-machine service

- stateless API
- transactional session catalog and fenced journal
- object artifact store
- managed work queue
- capability-specific worker pools
- external browser/sandbox infrastructure

Every worker may be killed after any append. Nothing required for recovery
lives only in process memory.

### Serverless workers

- queue-triggered invocation
- one bounded segment per invocation
- deadline checkpoint with a safety margin
- continuation cap separate from delivery retry cap
- durable state restored from journal/artifacts
- cleanup of reused ephemeral storage

The same handler can move from Lambda to containers by changing its host
deadline and queue adapter.

### Deterministic or model-authored workflow

A workflow step can enqueue child sessions and wait for their terminal queue
state or `child.completed` events. Design-time workflows and model-authored
workflows use the same `SessionWorkDispatcher`. The workflow engine owns DAG
dependencies and replay; Harness Kernel owns session semantics and worker
delivery contracts.

## Adapter qualification

Memory implementations are executable references, not production claims.
Qualify real adapters in an isolated namespace:

```ts
const report = await checkOrchestration({
  adapter: "postgres-and-sqs",
  queue,
  journal, // the FencedJournalStore itself, not a bindExecutionLease() view
  runtime,
});

assertOrchestrationConformance(report);
```

The checks cover immutable/idempotent enqueue, capability routing, exclusive
leases, stale acknowledgements, retries, dead-lettering, continuations,
stale-writer journal fencing, fenced conditional appends, and expired-lease
rejection. The expiry check needs an advancing clock; a frozen deterministic
runtime cannot verify it and fails with an explicit message.

Also run `checkHarnessStorage()` for the semantic storage bundle. Passing an
interface type is not evidence that a remote adapter implements its atomicity
contract.

## Deliberate non-goals

The execution contracts do not prescribe:

- a particular queue, database, cloud, model, or browser provider;
- a DAG language or workflow scheduler;
- worker autoscaling policy;
- credential distribution;
- approval UX;
- an HTTP API or CLI argument grammar;
- exactly-once external side effects.

Those are assembly and policy decisions. The library provides the stable
boundaries that let them vary.
