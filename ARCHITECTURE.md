# Architecture

## Boundary

Harness Kernel owns durable semantic contracts. An application owns its models,
tools, policy, credentials, workflow topology, user experience, and deployment.

The semantic core is organized around five runtime objects:

1. **Policy:** an injected `ModelInvoker`.
2. **Log:** an injected `JournalStore`.
3. **Action surface:** an injected `ActionExecutor`.
4. **Environment:** whatever the action executor operates.
5. **Host services:** injected identity, time, hashing, and storage ports.

Everything else is a transformation around those objects.

For asynchronous or distributed execution, a second plane adds:

6. **Dispatch:** an injected `WorkQueue`.
7. **Worker boundary:** a bounded `WorkerHost`.
8. **Ownership:** a queue visibility lease plus a journal fencing lease.

These are execution contracts, not a prescribed scheduler or cloud.

## State layers

### Immutable run config

An `ImmutableRunConfig` identifies the worker, prompt, tool definitions, and
generation settings for a session. It is code-like state: versionable,
rollbackable, and suitable for A/B evaluation.

### Raw journal

Every session owns one append-only causal chain. Events distinguish:

- `context`: observations that may influence a future policy call;
- `trace`: telemetry and execution facts;
- `control`: lifecycle and orchestration facts.

`affectsContext` is explicit because category and model visibility are separate
concerns.

### Artifacts

Large, binary, repeated, or provider-native payloads belong in an
`ArtifactStore`. Events carry immutable SHA-256 references.
Filesystem reads re-check digest and byte count so corruption fails loudly.

### Projections

A projection is a pure fold over raw events. It may be materialized for speed,
but it is never authoritative. Version every projection whose semantics can
change.

The model-facing context is one projection. Compaction changes that projection
by adding a `context.compacted` event; it does not replace earlier events.

## Runtime and storage boundary

Portable modules contain no Node built-ins. Identity, timestamps, and SHA-256
hashing come from `RuntimeServices`. Persistence comes from four capability
ports: `JournalStore`, `ArtifactStore`, `ProjectionStore`, and
`SessionCatalog`.

The Node filesystem implementations live behind the explicit `/node` package
subpath. Database, object-store, browser, edge, and remote-service adapters can
implement the same ports without changing events, projections, or the loop.

The interface is not the complete guarantee. Adapter implementations must pass
the reusable conformance suite. In particular, journal expected-head comparison
and append are one atomic operation; projection storage remains disposable; and
config/session puts remain immutable.

## Loop

`runAgentLoop()` intentionally knows very little:

1. project context;
2. append `model.call.started`;
3. invoke the model;
4. append telemetry and the canonical assistant message;
5. execute tool calls concurrently;
6. append completion-order receipts;
7. append source-order tool-result messages;
8. repeat or return a data-shaped outcome.

Policy, retry strategy, approvals, sandboxing, provider streaming, retrieval,
and UI broadcasting remain outside this function.

`beforeTurn` lets a host renew queue and session leases. `shouldCheckpoint`
lets a bounded runtime stop before its deadline and continue from durable
history in another process.

## Execution plane

`WorkQueue` defines at-least-once work submission, capability routing,
visibility leases, heartbeats, retries, dead-lettering, and bounded
continuations. Queue state is operational state; it is not a replacement for
the semantic journal.

Retries repeat a failed delivery segment. Continuations begin a new segment
after a successful checkpoint. Each has an independent limit.

`WorkerHost` processes one delivery. Polling, concurrency, autoscaling, and
process lifecycle stay in the CLI, service, workflow activity, or serverless
host.

Queue fencing prevents stale acknowledgement but cannot by itself stop an
expired process from writing the session. `FencedJournalStore` therefore
provides an independent execution lease whose monotonically increasing token
must be checked atomically with every append. `bindExecutionLease()` presents
that guarantee through the ordinary `JournalStore` interface consumed by the
loop.

`SessionWorkDispatcher` connects child journals to the queue with a
deterministic work ID. Cross-system atomicity remains an application concern;
durable APIs should use a transactional outbox when session creation and queue
submission use different systems.

## Forks

A child session contains:

- its own descriptor and immutable config reference;
- its own raw journal;
- a pointer to one immutable event in its parent.

The child’s initial context is a projection of the parent through that event.
No parent events are copied. The parent receives one `child.completed` event,
whose conclusion is model-visible and whose evidence/artifact references remain
checkable.

This supports independent child compaction without destroying either journal.

## Effects and replay

Model calls and tool effects are nondeterministic. Their results must be
recorded rather than re-executed during replay.

Consequential action adapters should:

- accept the invocation’s `idempotencyKey`;
- return an external operation identifier;
- query the expected postcondition after ambiguous timeouts;
- use `pending` or `unknown` when completion cannot be established;
- attach evidence produced outside the model.

The loop checkpoints on `pending` or `unknown` instead of guessing.

## Extending the protocol

Prefer a new namespaced event type over modifying old event data. Readers must
ignore and preserve unknown events. Increase an event’s `version` when its data
contract changes incompatibly.

Do not add provider-specific fields to canonical messages unless the semantics
are genuinely shared. Use a provider adapter and a `provider` block or artifact
reference instead.

Provider encoders must either encode a block or throw. Silent omission creates
a false transcript and is never an acceptable compatibility strategy.

## Non-goals

- A prescribed durable DAG scheduler or workflow language
- A prescribed queue, lock service, database, or cloud
- Credential vaults
- Approval UX
- Provider SDK lifecycle
- Prompt management
- Retrieval/vector databases
- Framework-specific dependency injection

Those systems can consume the kernel’s events and implement its interfaces.
