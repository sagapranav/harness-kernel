# Agent Guide

This repository is a reusable library, not an application.

## Before changing it

Read:

1. `README.md`
2. `ARCHITECTURE.md`
3. `docs/EVENTS.md`
4. `docs/API.md` to locate exports without scanning source
5. `docs/PROVIDERS.md` when changing provider behavior
6. `docs/STORAGE.md` when changing runtime or persistence behavior
7. `docs/ORCHESTRATION.md` when changing queues, workers, leases, or deployment
8. `docs/ADOPTION.md` when integrating the kernel into an existing system
9. the module you intend to change

Run `npm run check` before and after any behavioral change.

## Invariants you must preserve

- Never rewrite, truncate, or silently repair a raw journal.
- Never make a projection authoritative.
- Never copy a parent transcript into a child journal.
- Never silently drop unknown provider content or unknown event types.
- Never interpret timeout as proof that a side effect did not occur.
- Never claim verification without evidence references.
- Never make absence impossible to represent.
- Never add a runtime dependency when a small interface is sufficient without
  explaining the tradeoff in `ARCHITECTURE.md`.
- Never import Node built-ins from the portable root dependency graph.
- Never claim an adapter is durable or distributed without declaring its
  `StorageProfile` and running the storage conformance suite.
- Never treat queue acknowledgement fencing as session-writer fencing.
- Never implement a distributed journal lease as a check-then-append race; the
  fencing token and append must be one atomic operation.
- Never conflate a failed delivery retry with a successful host continuation.
- Never remove the loop's expected-head compare-and-append or write to a
  session the loop is running.
- Never re-execute an action whose `action.started` event exists; reconcile it
  from the external postcondition instead.
- Never place a compaction boundary between a tool call and its result.

## How to reuse the library in another harness

1. Implement or choose a `JournalStore`.
2. Choose the remaining artifact, projection, and session catalog ports.
3. Run `checkHarnessStorage()` against an isolated adapter namespace.
4. Store one immutable `ImmutableRunConfig` per configuration version.
5. Normalize provider output into `NormalizedModelResponse`.
6. Wrap every tool surface behind `ActionExecutor`.
7. Append user observations with `messageEvent()`.
8. Pass an application-specific context projector to `runAgentLoop()` when
   retrieval or inherited state is needed.
9. Materialize UI, telemetry, and search views with projections.
10. Use `SessionManager.fork()` only when a separate context window buys
    isolation or independent evidence.
11. For asynchronous work, dispatch immutable session references through
    `WorkQueue` and qualify the adapter with `checkOrchestration()`.
12. For multi-machine execution, pass a `bindExecutionLease()` journal view to
    the loop and renew queue plus journal leases before each turn.

## Adding a provider

- Put normalization and encoding in `src/providers.ts` or a separate adapter
  package.
- Preserve stable semantic content as canonical blocks.
- Preserve unsupported content as a `provider` block or artifact.
- Record requested model, served model, usage, request ID, latency, stop reason,
  and provider errors where available.
- Add fixtures covering text, tools, usage, unusual content, and failure modes.

## Adding an event

- Use a namespaced past-tense name such as `browser.navigation.completed`.
- Decide independently whether it is context-visible.
- Keep data JSON-serializable.
- Include causal identifiers and evidence references rather than prose-only
  claims.
- Add a projection test proving older unknown events remain harmless.

## Pull request checklist

- [ ] Raw events remain immutable and forward compatible.
- [ ] New side effects have receipts and idempotency semantics.
- [ ] New derived state can be rebuilt.
- [ ] Child results can express no findings.
- [ ] Provider-native semantics are not flattened unnecessarily.
- [ ] Public APIs and examples are updated.
- [ ] Portable imports do not reach Node-only modules.
- [ ] Storage/runtime adapter changes pass conformance tests.
- [ ] Work queue and fenced-journal changes pass orchestration conformance.
- [ ] `npm run check` passes.
- [ ] `npm run pack:check` contains the expected public files.
