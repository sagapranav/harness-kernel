# Harness Kernel

Provider-neutral, append-only primitives for building agent harnesses.

Harness Kernel is deliberately smaller than an agent framework. It gives you
the pieces that remain useful across coding agents, research agents, browser
agents, scheduled agents, and deterministic multi-agent workflows:

- an immutable, causally linked event journal;
- pure context and cold projections over that journal;
- content-addressed artifact offloading;
- portable storage/runtime ports with reusable adapter conformance checks;
- canonical messages and telemetry with OpenAI, Anthropic, and
  OpenAI-compatible (OpenRouter) adapters, including streaming accumulation;
- a small provider-neutral agent loop;
- first-class child journals with inherited-context projection;
- a provider-neutral work queue, worker host, continuations, retries, and DLQ
  semantics;
- fenced single-writer execution leases for distributed session journals;
- action receipts, idempotency, evidence, and explicit absence semantics;
- crash-boundary recovery: interrupted actions reconcile against external
  postconditions, lost model responses are marked and re-invoked, and lost
  run outcomes are replayed from recorded telemetry.

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

The package has no runtime dependencies and is ESM-only. The portable core
requires ES2022 and Web Crypto; `@sagapranav/harness-kernel/node` requires
Node.js 20 or newer. The package name is reserved as
`@sagapranav/harness-kernel` if it is later published to npm.

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

The two integration points every harness fills in are both visible above:
`tools` in the immutable config declare what the model may call, and the
`ActionExecutor` executes those calls behind journaled receipts. Sub-agents
use the same mechanism — spawning a child is just another tool whose executor
calls `SessionWorkDispatcher.forkAndDispatch()`; see
[`examples/manager-workers.ts`](examples/manager-workers.ts) for the complete
composition.

Runnable, dependency-free examples (build once, then run the compiled file):

```bash
npm install && npm run build
node dist/examples/basic-agent.js
```

- [`examples/basic-agent.ts`](examples/basic-agent.ts) — the loop against a
  deterministic model and tool;
- [`examples/forked-review.ts`](examples/forked-review.ts) — child-session
  forking, inherited context, and `noneFound` results;
- [`examples/manager-workers.ts`](examples/manager-workers.ts) — agents and
  tools together: the manager's `spawn_agent` tool forks a capability-routed
  child worker on a different provider, the child runs its own tool, and its
  conclusion returns to the manager as one model-visible observation;
- [`examples/durable-worker.ts`](examples/durable-worker.ts) — the full
  durable composition: queue delivery, fenced session lease, lease renewal,
  deadline checkpoint, and a continuation finishing the run;
- [`examples/provider-normalization.ts`](examples/provider-normalization.ts)
  — provider payloads normalized to canonical messages and re-encoded for
  both providers;
- [`examples/openrouter-streaming.ts`](examples/openrouter-streaming.ts) — a
  live streaming agent over OpenRouter with tools (needs
  `OPENROUTER_API_KEY`; skips politely without it).

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

1. **Raw events are never rewritten. A compaction is another event.** Once an
   event is written it is never edited or deleted. Summarizing old history to
   save context does not remove those events; it appends a new
   `context.compacted` event that points at them, so the original record is
   always still there to audit or replay.
2. **Every event belongs to exactly one session journal.** An event is never
   shared between two sessions. If two sessions relate (a parent and its
   child), the link is stored as data inside an event, not by putting the same
   event in both journals.
3. **Every session has one linear causal head.** Each session is a single
   ordered chain: every event records the id of the event before it, and there
   is exactly one latest event ("the head"). There are no branches inside one
   session, so the order of what happened is never ambiguous.
4. **Configs are immutable and versioned.** The prompt, tool list, and model
   settings for a run are stored as a fixed, numbered version. To change them
   you write a new version instead of editing the old one, so you can always
   see exactly which configuration produced any given run.
5. **Provider-native data is normalized without being silently discarded.**
   Responses from OpenAI, Anthropic, or OpenRouter are converted into one
   common shape, but nothing is thrown away in the process: content this
   version does not recognize is kept as a `provider` block, and the exact
   original response is retained for audit.
6. **Tool effects return receipts; timeouts may mean `unknown`, not `failed`.**
   Every tool call records a receipt describing what happened. If a call times
   out, the kernel does not assume it failed — the effect may have succeeded —
   so it records the status as `unknown` and reconciles it later instead of
   blindly retrying and doing the work twice.
7. **A child owns a new journal. Its inherited parent context and its result in
   the parent are projections.** A sub-agent gets its own separate journal. It
   can read a snapshot of the parent's history up to the point it was forked,
   but that snapshot is computed on demand — no parent events are copied — and
   the child's answer shows up in the parent as a single summarizing event.
8. **Absence is representable. Child results support `noneFound`.** A sub-agent
   can explicitly report "I looked and found nothing." That is a real, distinct
   result, not an empty response or an error, so the parent can tell the
   difference between "no answer yet" and "the answer is that there is nothing."
9. **Unknown event types survive reads.** An older version of the code can read
   a journal that contains newer event types it does not understand. It ignores
   those events but preserves them, so upgrading and downgrading never destroys
   data written by another version.
10. **Cold projections are disposable. They can always be rebuilt from raw
    events and artifacts.** Derived views — the model's context, telemetry
    totals, search indexes, UI state — are caches. You can delete any of them
    and recompute it exactly from the raw events and stored artifacts, so a
    corrupted or outdated view is never a real loss.
11. **Queue delivery is at least once. Retries and continuations are distinct.**
    A work item may be delivered more than once, so handlers must be safe to
    run again. A "retry" means re-running a delivery that failed; a
    "continuation" means picking up after a successful pause (like a serverless
    deadline). They are counted separately so a long, healthy run is not
    mistaken for a flaky, failing one.
12. **One distributed worker owns a session journal at a time. A stale writer
    is rejected by an atomic fencing token, not merely a liveness check.** When
    work runs across machines, only one worker may write to a session at once.
    Ownership is enforced by a number that increases each time ownership
    changes and is checked in the same step as the write — so a slow or paused
    old worker that "comes back to life" cannot corrupt the journal, even if it
    still believes it is in charge.
13. **The loop never writes blind. Every loop append is an expected-head
    compare-and-append; a foreign write surfaces as a conflict, not an
    interleaved transcript.** Before adding an event, the loop states which
    event it expects to currently be the head. If anything else has written in
    the meantime, the write is rejected with a conflict instead of quietly
    mixing two writers' events together and producing a garbled transcript.
14. **Crashes stall a run, never a session.** If the process dies at any point
    — mid-tool-call, after a model reply but before it was saved, or after the
    work finished but before that was recorded — the next start inspects the
    journal and has a defined repair for that exact situation. A crash pauses
    progress; it never leaves a session permanently broken or unusable.

## Images, files, and other large payloads

Large or binary data — screenshots, downloads, PDFs, model image output — is
never stored inside events. The bytes go into the `ArtifactStore`, which keys
them by their SHA-256 digest, and the event carries only a small `ArtifactRef`
(the digest, a `sha256:` URI, the byte count, and a media type). This keeps
journals small and text-only, makes identical bytes deduplicate automatically,
and lets reads verify integrity by re-checking the digest.

```ts
// store the bytes, get back a reference
const ref = await storage.artifacts.put(pngBytes, { mediaType: "image/png" });

// the reference (not the bytes) travels inside a tool result / message
const block = { type: "image", artifact: ref };

// resolve the bytes back by reference, integrity-checked
const bytes = await storage.artifacts.get(ref);
```

With `createFileStorage`, the bytes live on disk under
`<root>/artifacts/<first-two-digest-chars>/<digest>`; with `createMemoryStorage`
they live in memory.

**Passing a tool-produced image back to the model.** When a tool returns an
image, that image needs to reach the model on the next turn. The reference
travels through the journal and into the next turn's context automatically, but
the encoders are synchronous and cannot read the artifact store, so before
encoding you resolve the bytes with `inlineArtifactBytes(messages, artifacts)`.
It fetches each image/file's bytes (including images nested in tool results) and
attaches base64, which the encoders then emit as a real provider image payload:

```ts
const model: ModelInvoker = {
  async invoke(request) {
    const messages = await inlineArtifactBytes(
      request.context.messages,
      storage.artifacts,
    );
    return callProvider(toAnthropicInput(messages)); // or toOpenAIChatInput
  },
};
```

One provider difference is unavoidable and enforced by their APIs: **Anthropic**
accepts an image directly inside the tool result, so this just works. **OpenAI**
(Chat Completions and Responses) cannot put an image in a tool message, so the
tool result stays text ("screenshot captured") and your handler relays the image
as a following `user` message — where inlining turns it into a data-URL image
part. If you skip resolution entirely, the encoders throw (or emit an explicit
`[unencodable …]` placeholder under `{ unencodable: "describe" }`) rather than
silently dropping the image. See [docs/STORAGE.md](docs/STORAGE.md) and
[docs/PROVIDERS.md](docs/PROVIDERS.md).

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
the parent context they received at their fork point. Validate the boundary
with `compactionBoundaryError()` first: a boundary that separates a tool call
from its result would produce a transcript providers reject, and
`projectContext()` ignores such compactions.

## Provider policy

The protocol is a semantic intermediate representation, not a union of vendor
JSON schemas. OpenAI- and Anthropic-specific behavior belongs in adapters.
Unknown blocks may remain as `provider` blocks or be offloaded to an artifact.
Normalization retains an exact provider snapshot by default. Pass a
`rawArtifact` to keep that snapshot content-addressed instead of inline, or set
`preserveRawResponse: false` when another layer already owns the raw payload.
Outbound encoders throw `ProviderEncodingError` for content they cannot encode;
they never silently discard a canonical block. Pass
`{ unencodable: "describe" }` to downgrade such blocks to explicit text
placeholders instead — for example when re-encoding history across providers.

Adding another provider should require a new adapter, not a journal migration.
The `provider` field is therefore an extensible string. OpenRouter and other
OpenAI-compatible endpoints work through `toOpenAIChatInput()` /
`fromOpenAIChatCompletion()`; streaming responses fold through
`sseJsonEvents()` and `createChatCompletionStreamAccumulator()` while the loop
forwards live deltas via `onModelStream` and journals only the complete
response.

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

`JsonlJournalStore` remains single-instance. It heals a torn tail line left by
a crash and caches its tail so appends stay O(1), but multiple writers require
a transactional journal implementation with atomic expected-head comparison.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before extending the event model and
[docs/STORAGE.md](docs/STORAGE.md) before implementing a storage/runtime adapter.
Read [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) before building a manager,
CLI worker pool, queue adapter, or multi-machine deployment.
Read [docs/PROVIDERS.md](docs/PROVIDERS.md) before writing a provider adapter.
Read [docs/ADOPTION.md](docs/ADOPTION.md) for recipes that add the kernel to an
existing harness, database, retrieval layer, or workflow engine.
[docs/API.md](docs/API.md) indexes every exported symbol by module. Use
[AGENTS.md](AGENTS.md) when asking an implementation agent to adopt the library.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT
