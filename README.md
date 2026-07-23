# Harness Kernel

Provider-neutral, append-only primitives for building agent harnesses.

Harness Kernel is deliberately smaller than an agent framework. It gives you
the pieces that remain useful across coding agents, research agents, browser
agents, scheduled agents, and deterministic multi-agent workflows:

- an immutable, causally linked event journal;
- pure context and cold projections over that journal;
- content-addressed artifact offloading;
- canonical messages and telemetry with OpenAI and Anthropic adapters;
- a small provider-neutral agent loop;
- first-class child journals with inherited-context projection;
- action receipts, idempotency, evidence, and explicit absence semantics.

It does **not** prescribe a tool catalog, model SDK, database, UI, workflow
engine, sandbox, or policy system.

## The model

```text
Provider response
      │
      ▼
Provider adapter ──→ canonical message + telemetry
      │
      ▼
Flat agent loop ───→ action executor
      │                    │
      └──── append events ◀┘
                 │
                 ▼
         immutable raw journal ───→ content-addressed artifacts
                 │
        ┌────────┼───────────────┐
        ▼        ▼               ▼
    context   cold views     audit/evals
   projection
```

The raw journal is authoritative. Context, compaction, UI state, telemetry,
search indexes, and child summaries are replaceable projections.

## Install

```bash
npm install github:sagapranav/harness-kernel
```

The package has no runtime dependencies and requires Node.js 20 or newer.
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
for child-session semantics.

## Package map

| Import                                | Responsibility                                             |
| ------------------------------------- | ---------------------------------------------------------- |
| `@sagapranav/harness-kernel/protocol` | Canonical messages, events, configs, receipts and evidence |
| `…/journal`                           | In-memory and fsynced JSONL append-only stores             |
| `…/artifacts`                         | In-memory and filesystem content-addressed blobs           |
| `…/json`                              | Durable JSON validation and defensive cloning              |
| `…/projection`                        | Context folds, compaction events and cold projections      |
| `…/providers`                         | OpenAI/Anthropic normalization and outbound encoding       |
| `…/loop`                              | The flat model → tools → model loop                        |
| `…/sessions`                          | Immutable configs, sessions, forks and inherited context   |
| `…/telemetry`                         | Rebuildable aggregate usage and action metrics             |

The root import re-exports every public symbol.

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

## Production adaptation

The included memory and filesystem stores are reference implementations. For a
distributed runtime, implement the small `JournalStore`, `ArtifactStore`,
`ProjectionStore`, and `SessionCatalog` interfaces over your own database or
object store. Preserve optimistic head checks and per-session append
linearization. `JsonlJournalStore` serializes one in-process store instance; do
not point multiple processes or multiple store instances at the same directory.
Filesystem implementations hash application identifiers into bounded path
components, so IDs do not need filesystem-safe syntax.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before extending the event model and
[docs/PROVIDERS.md](docs/PROVIDERS.md) before writing an adapter. Use
[AGENTS.md](AGENTS.md) when asking an implementation agent to adopt the library.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT
