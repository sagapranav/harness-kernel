# Agent Guide

This repository is a reusable library, not an application.

## Before changing it

Read:

1. `README.md`
2. `ARCHITECTURE.md`
3. `docs/EVENTS.md`
4. `docs/PROVIDERS.md` when changing provider behavior
5. the module you intend to change

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

## How to reuse the library in another harness

1. Implement or choose a `JournalStore`.
2. Store one immutable `ImmutableRunConfig` per configuration version.
3. Normalize provider output into `NormalizedModelResponse`.
4. Wrap every tool surface behind `ActionExecutor`.
5. Append user observations with `messageEvent()`.
6. Pass an application-specific context projector to `runAgentLoop()` when
   retrieval or inherited state is needed.
7. Materialize UI, telemetry, and search views with projections.
8. Use `SessionManager.fork()` only when a separate context window buys
   isolation or independent evidence.

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
- [ ] `npm run check` passes.
- [ ] `npm run pack:check` contains the expected public files.
