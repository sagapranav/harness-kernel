# Harness Kernel

Provider-neutral, append-only primitives for building agent harnesses.

Harness Kernel is deliberately smaller than an agent framework. It gives you
the pieces that remain useful across coding agents, research agents, browser
agents, scheduled agents, and deterministic multi-agent workflows:

- an immutable, causally linked event journal;
- pure context and cold projections over that journal;
- content-addressed artifact offloading;
- portable storage/runtime ports with reusable adapter conformance checks;
- canonical messages and telemetry with OpenAI and Anthropic adapters;
- a small provider-neutral agent loop;
- first-class child journals with inherited-context projection;
- a provider-neutral work queue, worker host, continuations, retries, and DLQ
  semantics;
- fenced single-writer execution leases for distributed session journals;
- action receipts, idempotency, evidence, and explicit absence semantics.

It does **not** prescribe a tool catalog, model SDK, database, UI, workflow
engine, sandbox, or policy system.

## The model

```text
API / CLI ──→ work queue ──→ worker host ──→ browser / sandbox / tools
                  │               │
            retry + lease     fenced session writer
                                  │
Provider adapter ──→ flat agent loop ──→ immutable raw journal
       │                                      │
       └─ canonical message + telemetry       ├─→ artifacts
                                              ├─→ context
                                              └─→ cold views / audit / evals
```

The raw journal is authoritative. Context, compaction, UI state, telemetry,
search indexes, and child summaries are replaceable projections.

## Install

```bash
npm install github:sagapranav/harness-kernel
```

The package has no runtime dependencies. The portable core requires ES2022 and
Web Crypto; `@sagapranav/harness-kernel/node` requires Node.js 20 or newer.
The package name is reserved as `@sagapranav/harness-kernel` if it is later
published to npm.

## A minimal agent

```ts
import {
  MemoryJournalStore,
  MemorySessionCatalog,
  SessionManager,
  createId,
  messageEvent,
  nowIso,
  runAgentLoop,
  type ActionExecutor,
  type ImmutableRunConfig,
  type ModelInvoker,
} from "@sagapranav/harness-kernel";

const journal = new MemoryJournalStore();
const sessions = new SessionManager(journal, new MemorySessionCatalog());

const config: ImmutableRunConfig = {
  id: createId("config"),
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "openai", model: "your-model" },
  tools: [
    {
      name: "search",
      description: "Search the application corpus.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
};

const session = await sessions.create(config, { purpose: "Answer a question" });
await journal.append(
  session.id,
  messageEvent({
    id: createId("msg"),
    role: "user",
    createdAt: nowIso(),
    content: [{ type: "text", text: "What changed?" }],
  }),
);

const model: ModelInvoker = {
  async invoke(request) {
    // Call an SDK, then normalize with fromOpenAIResponse(),
    // fromOpenAIChatCompletion(), or fromAnthropicMessage().
    return callYourProvider(request);
  },
};

const actions: ActionExecutor = {
  async execute(invocation) {
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [{ type: "text", text: "Result from your tool adapter" }],
    };
  },
};

const outcome = await runAgentLoop({
  sessionId: session.id,
  config,
  journal,
  model,
  actions,
});
```

See [`examples/basic-agent.ts`](examples/basic-agent.ts) for a runnable
dependency-free example and [`examples/forked-review.ts`](examples/forked-review.ts)
for child-session semantics. [`examples/manager-workers.ts`](examples/manager-workers.ts)
shows a Claude-configured manager dispatching a capability-routed child worker.

## Package map

| Import                                | Responsibility                                             |
| ------------------------------------- | ---------------------------------------------------------- |
| `@sagapranav/harness-kernel/protocol` | Canonical messages, events, configs, receipts and evidence |
| `…/journal`                           | Portable journal contract and memory implementation        |
| `…/execution`                         | Fenced single-writer leases for distributed journals       |
| `…/artifacts`                         | Portable artifact contract and memory implementation       |
| `…/conformance`                       | Reusable storage and execution-adapter contract checks     |
| `…/json`                              | Durable JSON validation and defensive cloning              |
| `…/projection`                        | Context folds, compaction events and cold projections      |
| `…/providers`                         | OpenAI/Anthropic normalization and outbound encoding       |
| `…/loop`                              | The flat model → tools → model loop                        |
| `…/work`                              | Work queue, leases, retries, continuations and worker host |
| `…/orchestration`                     | Idempotent session and child-run dispatch                  |
| `…/runtime`                           | Injectable identity, time, and SHA-256 host services       |
| `…/sessions`                          | Immutable configs, sessions, forks and inherited context   |
| `…/storage`                           | Complete storage bundles and operational profiles          |
| `…/telemetry`                         | Rebuildable aggregate usage and action metrics             |
| `…/node`                              | Node-only filesystem adapters and bundle factory           |

The root import re-exports the portable public API. Node adapters are only
available from the explicit `/node` subpath.

## Core invariants

1. **Raw events are never rewritten.** A compaction is another event.
2. **Every event belongs to exactly one session journal.**
3. **Every session has one linear causal head.**
4. **Configs are immutable and versioned.**
5. **Provider-native data is normalized without being silently discarded.**
6. **Tool effects return receipts; timeouts may mean `unknown`, not `failed`.**
7. **A child owns a new journal.** Its inherited parent context and its result in
   the parent are projections.
8. **Absence is representable.** Child results support `noneFound`.
9. **Unknown event types survive reads.**
10. **Cold projections are disposable.** They can always be rebuilt from raw
    events and artifacts.
11. **Queue delivery is at least once.** Retries and continuations are distinct.
12. **One distributed worker owns a session journal at a time.** A stale writer
    is rejected by an atomic fencing token, not merely a liveness check.

## Compaction

Compaction does not mutate history:

```ts
await journal.append(
  session.id,
  compactionEvent({
    summarizesThroughEventId: boundary.id,
    summary,
    evidenceRefs,
    scope: "including_inherited",
    projectorVersion: 1,
  }),
);
```

`projectContext()` uses the latest valid compaction event and retains later
messages verbatim. Child sessions can use `including_inherited` to summarize
the parent context they received at their fork point.

## Provider policy

The protocol is a semantic intermediate representation, not a union of vendor
JSON schemas. OpenAI- and Anthropic-specific behavior belongs in adapters.
Unknown blocks may remain as `provider` blocks or be offloaded to an artifact.
Normalization retains an exact provider snapshot by default. Pass a
`rawArtifact` to keep that snapshot content-addressed instead of inline, or set
`preserveRawResponse: false` when another layer already owns the raw payload.
Outbound encoders throw `ProviderEncodingError` for content they cannot encode;
they never silently discard a canonical block.

Adding another provider should require a new adapter, not a journal migration.
The `provider` field is therefore an extensible string.

## Storage and runtime adaptation

The portable root never loads Node built-ins. Use the complete in-memory bundle
for transient work:

```ts
import { createMemoryStorage } from "@sagapranav/harness-kernel";

const storage = createMemoryStorage();
```

Node applications can opt into the durable filesystem reference bundle:

```ts
import { createFileStorage } from "@sagapranav/harness-kernel/node";

const storage = createFileStorage("./harness-data");
```

For SQLite, Postgres, object storage, browser storage, workers, or a distributed
runtime, implement the small persistence and execution ports. Run
`checkHarnessStorage()` and `checkOrchestration()` against isolated adapter
namespaces. Runtime-created IDs, timestamps, and SHA-256 hashing are also
injectable through `RuntimeServices`.

`JsonlJournalStore` remains single-instance. Multiple writers require a
transactional journal implementation with atomic expected-head comparison.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before extending the event model and
[docs/STORAGE.md](docs/STORAGE.md) before implementing a storage/runtime adapter.
Read [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) before building a manager,
CLI worker pool, queue adapter, or multi-machine deployment.
Read [docs/PROVIDERS.md](docs/PROVIDERS.md) before writing a provider adapter.
Use
[AGENTS.md](AGENTS.md) when asking an implementation agent to adopt the library.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT
