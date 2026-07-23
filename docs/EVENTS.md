# Event contracts

Every event uses the same envelope:

```ts
interface JournalEvent<TData> {
  id: string;
  sessionId: string;
  sequence: number;
  parentId: string | null;
  timestamp: string;
  category: "context" | "trace" | "control";
  type: string;
  version: number;
  turnId: string | null;
  affectsContext: boolean;
  data: TData;
}
```

`sequence` is local to one session. `parentId` is the previous event in that
same session. Cross-session relationships live in event data.

## Core event types

| Event                    | Category | Context | Purpose                                                         |
| ------------------------ | -------- | ------: | --------------------------------------------------------------- |
| `session.started`        | control  |      no | Records the session descriptor (its config is referenced by ID) |
| `message.appended`       | context  |     yes | Adds a canonical observation                                    |
| `context.compacted`      | context  |     yes | Replaces covered messages in the working view                   |
| `model.call.started`     | trace    |      no | Records config reference, provider, and context boundary        |
| `model.call.completed`   | trace    |      no | Records usage, termination, latency and errors                  |
| `model.call.interrupted` | trace    |      no | Marks a crash window in which the model response was lost       |
| `model.protocol.error`   | trace    |      no | Records a normalized response that violated the protocol        |
| `action.started`         | trace    |      no | Records invocation, authority and idempotency                   |
| `action.completed`       | trace    |      no | Records the side-effect receipt                                 |
| `child.started`          | trace    |      no | Relates parent, child and immutable fork event                  |
| `child.completed`        | context  |     yes | Returns conclusion and evidence to the parent                   |
| `run.completed`          | control  |      no | Records the loop outcome                                        |

The canonical names are exported as `EVENT_TYPES`. Applications may append
namespaced types. Unknown types must survive storage round trips and be
ignored by projections that do not understand them.

## Compaction

A valid `context.compacted` event points to an earlier event in the same
journal. Its summary replaces context-visible messages through that boundary.
Later messages remain verbatim.

The boundary must not separate a tool call from its recorded result; the
projected transcript would carry unpaired blocks that provider APIs reject.
Check candidate boundaries with `compactionBoundaryError()` before appending.
`projectContext()` ignores compactions with unsafe boundaries the same way it
ignores malformed ones.

For a root session use `scope: "local"`. A child may use
`scope: "including_inherited"` when the summary was generated from the complete
inherited-plus-local working context.

Evidence references travel with the summary. A load-bearing claim without its
receipt should be treated as unverified after compaction.

## Actions

An action has two records:

- `ActionInvocation`: intent, correlation, authority, idempotency, expected
  postcondition.
- `ActionReceipt`: observed status, output, external operation identifier,
  postcondition and evidence.

`unknown` is intentionally distinct from `failed`. It normally triggers a
reconciliation step rather than a blind retry.

At loop startup, the kernel inspects raw events before calling the model
(`inspectActionState()`) and repairs each crash boundary:

- A terminal receipt missing its model-visible tool-result message is
  repaired from the receipt.
- A started action without a terminal receipt is passed to the host's
  `reconcileAction` hook, which checks the external postcondition and returns
  a terminal receipt; without a hook (or when the postcondition is still
  unknown) the run checkpoints. `appendActionReconciliation()` records the
  same repair outside the loop.
- A tool call journaled before its `action.started` event never began its
  side effect, so the loop executes it and continues.
- A `model.call.started` with no completion, or a completion whose assistant
  message was never journaled, is marked with `model.call.interrupted` and the
  turn is re-invoked — the response was lost before it became durable.
- A finished no-tool-call turn whose `run.completed` append was lost is
  replayed from the recorded stop reason without re-invoking the model.

When a reconciled receipt supersedes an earlier `pending` result, the raw
journal keeps both receipts, but `projectContext()` keeps only the latest
tool result per call so the model never sees contradictory duplicates.

## Children

The parent records lifecycle events but never embeds the child transcript.
`ChildResult` supports:

- a concise conclusion;
- `noneFound`;
- confidence;
- evidence references;
- artifact references;
- explicit completed, failed or cancelled status.

The child’s raw journal remains available for audit.
