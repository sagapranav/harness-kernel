# Event contracts

Every event uses the same envelope:

```ts
interface JournalEvent<TData> {
  id: string;
  sessionId: string;
  sequence: number;
  parentId: string | null;
  timestamp: string;
  category: 'context' | 'trace' | 'control';
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

| Event | Category | Context | Purpose |
|---|---|---:|---|
| `session.started` | control | no | Pins session descriptor and config |
| `message.appended` | context | yes | Adds a canonical observation |
| `context.compacted` | context | yes | Replaces covered messages in the working view |
| `model.call.started` | trace | no | Records the exact requested configuration |
| `model.call.completed` | trace | no | Records usage, termination, latency and errors |
| `action.started` | trace | no | Records invocation, authority and idempotency |
| `action.completed` | trace | no | Records the side-effect receipt |
| `child.started` | trace | no | Relates parent, child and immutable fork event |
| `child.completed` | context | yes | Returns conclusion and evidence to the parent |
| `run.completed` | control | no | Records the loop outcome |

Applications may append namespaced types. Unknown types must survive storage
round trips and be ignored by projections that do not understand them.

## Compaction

A valid `context.compacted` event points to an earlier event in the same
journal. Its summary replaces context-visible messages through that boundary.
Later messages remain verbatim.

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
