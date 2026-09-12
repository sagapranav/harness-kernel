# Session mailboxes and reliable handoff

Mailboxes deliver observations between independently executing sessions. A
parent can send a note to a child; a child can send progress, a question, or a
final result to the parent. Both directions use the same `MailboxStore`.

Senders write the mailbox. Only the recipient's current owner writes the
recipient journal. A message arriving during a model call therefore does not
change that loop's expected journal head or invalidate its in-flight response.

## What ships

| Component                    | Responsibility                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `MailboxStore`               | Portable send, lookup, ordered reads, acknowledgement, pending-recipient discovery |
| `MemoryMailboxStore`         | Ephemeral single-instance reference adapter                                        |
| `FileMailboxStore` (`/node`) | Durable single-instance filesystem reference adapter                               |
| `receiveMailbox()`           | Recoverable append-before-ack delivery between loop executions                     |
| `runAgentLoop({ mailbox })`  | Delivery through the loop's tracked writer at turn boundaries                      |
| `waitForMailbox()`           | Bounded, cancellable wait for pending mail using storage reads                     |
| `checkMailboxStore()`        | Reusable adapter contract checks                                                   |

Mailbox state is operational delivery state, alongside the work queue. It is
not a fifth required `HarnessStorage` port. Existing storage bundles and callers
remain compatible; supply a mailbox separately. Every mailbox declares its own
`StorageComponentProfile`.

No database driver, cloud service, background daemon, or model SDK is required.
SQLite/Postgres/remote-service implementations supply the same interface.

## The message contract

```ts
const note: MailboxMessage = {
  id: "research-42:note-1",
  senderSessionId: parent.id,
  recipientSessionId: child.id,
  createdAt: "2026-01-01T10:00:00.000Z",
  body: {
    type: "message",
    content: [{ type: "text", text: "Please investigate enterprise pricing." }],
  },
};
await mailbox.send(note);
```

- IDs are unique across one mailbox store. Reuse the **same complete envelope**
  on retry, including `createdAt`, body, and metadata. Do not regenerate the
  timestamp or message ID when retrying after an uncertain send response.
- Identical sends return the existing record, even after delivery. A different
  envelope under the same ID throws `MailboxConflictError`.
- `replyToMessageId` optionally links a reply. `metadata` carries application
  data. The store does not validate that referenced sessions/messages exist.
- `message` bodies accept text, image, and file blocks. Images/files carry
  ordinary artifact references. Tools, assistant output, and system instructions
  cannot be injected as mailbox body types.
- The recipient sees an attributed canonical **user observation**. That role
  does not establish human authorship or grant authority. Sender identity and the
  mailbox ID appear in a leading text block so provider encoders carry them to
  the model, and are also retained in message metadata. The complete envelope,
  including application-specific metadata, remains in the raw event.
- Routing identifiers are not authentication. The application must enforce
  send/read/delivery permissions, validate allowed parent-child relationships,
  and prevent untrusted callers from acknowledging mail.

Each accepted `MailboxRecord` has a store-wide increasing `sequence`, an
`acceptedAt` timestamp, and `pending`/`delivered` status. Acceptance order, sender
timestamps, and recipient journal sequence are three distinct things. Late mail
is never inserted into earlier journal history.

## Integrating the loop

```ts
const mailbox = new MemoryMailboxStore();

const outcome = await runAgentLoop({
  sessionId: session.id,
  config,
  journal, // use bindExecutionLease(...) in a distributed worker
  mailbox,
  maxMailboxMessagesPerTurn: 100,
  model,
  actions,
  project: () => sessions.project(session.id),
});
```

The loop repairs interrupted actions first. Before a new model turn it runs
`beforeTurn` (for lease renewal), drains a bounded pending batch through its own
expected-head writer, then constructs context. New arrivals during a model/tool
operation wait for a later boundary. Continuous senders cannot prevent the next
model call by growing the batch indefinitely.

If a normal final response races incoming mail, the loop records the response,
incorporates an available batch, and takes another turn within `maxTurns`. A
message can still arrive after that check; the host's pending-mail recovery scan
and wake coordination remain necessary. Turn-limit/deadline checkpoints also
leave remaining messages for a later invocation.

`delivered` means **incorporated into raw history**, not read, understood, acted
on, or included in a completed model call. If the process stops immediately
after delivery, the next invocation reconstructs the observation from the
journal. A custom `project` function must include the delivered observations if
they should reach the model; a projection may deliberately summarize/filter them.

Do not call `receiveMailbox()` or `completeChild()` from another process while
the recipient loop is active. Do not append mail from `beforeTurn` yourself;
that would bypass the loop's tracked head. Use the `mailbox` option instead.

Between loop executions, the session owner can call:

```ts
await receiveMailbox({ sessionId, journal, mailbox, maxMessages: 100 });
```

The default receiver uses expected-head comparison. Its optional `append`
callback is for an existing recipient-owned tracked writer, as used by the loop;
it must preserve journal fencing and expected-head checks. It is not permission
for a second concurrent writer. All delivery paths retain normal journal errors;
failed writes never acknowledge mail.

Mail is not an urgent-interruption mechanism. A model response may still execute
its tools before a newly arrived note is incorporated. An unresolved external
effect keeps the run checkpointed for reconciliation before mailbox delivery.
Urgency, cancellation, postcondition repair, and whether another decision may
authorize an external action remain application policy.

## Child findings and parent notes use one transport

Final child results use the existing `ChildResult` contract:

```ts
await mailbox.send({
  id: `${child.id}:final-result`,
  senderSessionId: child.id,
  recipientSessionId: parent.id,
  createdAt: child.createdAt, // stable across retries
  body: {
    type: "child_result",
    result: {
      childSessionId: child.id,
      status: "completed",
      noneFound: true,
      evidenceRefs: [],
      artifactRefs: [],
    },
  },
});
```

The sender must match `result.childSessionId`. Validate the actual parent-child
relationship and authorization in your host before accepting the send; the
mailbox and loop do not load the session catalog to verify that relationship.

Delivery appends `child.completed`, preserving `noneFound`, confidence, evidence,
artifacts, and existing viewer navigation. `SessionManager.completeChild()`
remains available for direct delivery when the parent is not running.

An identical child completion already in the recipient journal is reused, even
if delivered directly or under another mail ID. Its existing event is the
acknowledgement target. Conflicting conclusions for the same child fail and
remain pending for host intervention. Progress updates should be ordinary
`message` bodies; final child completion is immutable.

See [examples/mailbox-handoff.ts](../examples/mailbox-handoff.ts): two children
receive parent notes, return findings while the parent performs a tool operation,
and persist their deliveries to disk without foreign writes to the parent journal.

## Crash recovery and delivery guarantees

The portable receiver works across independent storage backends:

1. Read a finite batch of pending messages.
2. Search **raw** recipient history for the immutable message ID/envelope.
3. If absent, append the observation with the recipient's conditional/fenced writer.
4. Only after append commits, acknowledge the mailbox with the event ID, sequence,
   recipient session, and event timestamp.

| Interruption                                       | Recovery                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Send was not committed                             | Retry the same envelope                                               |
| Send committed; response was lost                  | Same-ID send returns the accepted record                              |
| Worker died with pending mail                      | Reopen storage and discover pending recipients                        |
| Journal append failed/conflicted                   | Mail remains pending; restore ownership before retry                  |
| Journal append committed; acknowledgement was lost | Find the raw delivery event and acknowledge it without another append |
| Acknowledgement committed; its response was lost   | Mail is already delivered; retry cannot reopen it                     |
| Delivery committed; model has not consumed it      | Resume the scheduled session from its journal                         |
| Covered delivery was compacted                     | Raw-history lookup still prevents duplicate incorporation             |

This is at-least-once delivery attempts with idempotent journal incorporation
under a single recipient owner. It does not promise exactly-once model calls or
external actions. Never delete delivery evidence from raw journals or discard
message identities while retries remain possible.

The journal and mailbox do not need a shared transaction for this protocol. A
database integration can provide an atomic append-and-ack fast path, but the
current portable ports do not expose a shared transaction. Do not claim that
two separately awaited store calls commit atomically.

`acknowledge()` validates correlation and rejects changed delivery receipts.
The mailbox adapter cannot independently prove that an event exists in another
backend: only the trusted recipient-side handoff should call it.

## Waiting, monitoring, and wake-up handoff

```ts
const update = await waitForMailbox(mailbox, parent.id, {
  timeoutMs: 30_000,
  pollIntervalMs: 250,
  signal,
});
// available: pending records; timeout: no available mail observed; cancelled: aborted
```

This waits for **any pending mail**, including mail accepted before waiting. It
does not acknowledge or advance a journal. It polls durable state rather than
depending on a transient notification, so mail arriving between checks remains
visible. Timeouts use elapsed host time; in-flight adapter reads must themselves
be bounded because cancellation cannot forcibly abort an arbitrary store call.

The waiting promise is process-local. Reissue it after restart. The kernel does
not persist wait-for-all predicates, automatically resume stopped sessions, or
create a worker per incoming message. A deployed scheduler should:

1. Save its own session/work identity and any required wait condition durably.
2. On startup and periodically, call `pendingRecipients()` to recover missed
   notifications. A notification is only a prompt to inspect durable state.
3. Coalesce arrivals into one active/scheduled recipient execution and acquire
   its journal lease. Pending mail does not override a policy/reconciliation block.
4. Keep work recoverable until the recipient run is resolved. Once mail is
   delivered, it disappears from the pending scan; recovery after that point
   depends on the active work lease/queue or equivalent durable host state.
5. Recheck for mail when entering an idle/waiting state. Coordinate that check
   with wake scheduling, or use repeated durable scans, to avoid a missed wake.

`WorkQueue.checkpoint()` requeues a continuation and counts it toward its limit;
it is not a durable wait subscription. Repeatedly checkpointing to poll an empty
inbox consumes continuations. A completed work item's default session-derived ID
also cannot be re-enqueued to reopen it. Follow-up executions need stable unique
work IDs for each wake/segment, or a still-active continuation managed by the host.

Monitor `MailboxStore.read()` for delivery status, `WorkQueue.get()` for execution
status, and journal reads for recorded progress. `afterSequence` is an acceptance
cursor; it does not track later status changes on an old record. For example,
re-read `get(messageId)` to observe its acknowledgement. Receivers must query
pending mail from the beginning, as `receiveMailbox` does, rather than advancing
past an unacknowledged message with a monitoring cursor.

## Storage adapters

`MemoryMailboxStore` is ephemeral. Its versioned `snapshot()` and constructor
restore support adapter implementations and tests, not automatic durability.

```ts
import { FileMailboxStore } from "@sagapranav/harness-kernel/node";
const mailbox = new FileMailboxStore("./harness-data/mailbox");
```

The filesystem reference stores one `mailbox.json` snapshot. Mutations serialize
within one instance. Each save flushes a new temporary file, renames it over the
snapshot, and syncs the directory and its parent. Old temporary files are ignored
after a crash. Corrupt or unknown-version committed snapshots fail loudly.

Use one writing instance per root. It rewrites/reads the full snapshot, so it is
O(n) and intended for local workloads and as a persistence reference. It needs a
filesystem supporting atomic replacement and directory syncing, on persistent
storage. It does not provide multi-process locks, replication, backups, garbage
collection, or survival of a lost disk. Concurrent read-only observers may reopen
the committed snapshot; multiple writers need a database adapter.

A SQL adapter can use a unique message ID, indexed recipient/sequence/status,
immutable JSON payload, and a write-once delivery receipt. Acceptance sequence
allocation and insert must be atomic and provide ordered visibility; an ordinary
sequence allocator alone does not ensure commit order. Acknowledgement must
atomically enforce recipient and existing-receipt equality. Snapshot all mutable
inputs before the first await and return defensive copies.

Run `checkMailboxStore(adapter)` in an isolated namespace. Or include `mailbox`
in `checkOrchestration({ adapter, queue, journal, mailbox })`. Passing memory
checks does not qualify an unrelated database adapter. Deployment-specific tests
must also cover process crashes, persistence, concurrent writers, and fencing.

## Integration checklist

- Keep envelope IDs and timestamps stable on retries.
- Validate sender authority and recipient relationships before sending.
- Store mail durably before reporting acceptance.
- Let only the recipient owner incorporate mail, using its fenced/conditional writer.
- Append before acknowledgement; retain raw delivery identity through compaction.
- Preserve active work recovery after acknowledgement and before model consumption.
- Treat pending scans as wake recovery, not as proof that work is allowed to resume.
- Distinguish accepted, delivered, included in context, and acted upon.
- Choose explicit policies for urgent notes, failed children, timeouts, and finalization.
