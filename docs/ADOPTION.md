# Adoption recipes

## Add the kernel to an existing single-agent harness

Start at the append boundary:

1. Convert the current transcript into `message.appended` events.
2. Emit model-call telemetry beside messages.
3. Wrap tools in `ActionExecutor` and produce receipts.
4. Derive the old transcript shape with `projectContext()`.
5. Switch the model caller to the projection only after replay tests match.

This lets storage change before orchestration.

## Use a database

Implement `JournalStore` with a unique key on `(session_id, sequence)` and a
transactional compare-and-append against the expected head. Keep event JSON
opaque enough to preserve unknown types.

Store artifacts by SHA-256 in object storage. Store cold projections in normal
tables or search indexes with `(projection_name, version, through_sequence)`.

Assemble the four implementations into `HarnessStorage`, declare their
durability and coordination in `StorageProfile`, then run
`checkHarnessStorage()` against a disposable adapter namespace. See
[STORAGE.md](STORAGE.md) for the complete contract.

## Add retrieval

Do not mutate the raw journal. Supply a custom `project` function to
`runAgentLoop()` that:

1. calls `projectContext()`;
2. retrieves relevant durable memory;
3. adds clearly labeled retrieval messages;
4. returns a `ContextProjection`.

Record retrieval queries and result artifact references as trace events if they
matter for debugging or evaluation.

## Add policy and approvals

Put a host-side gate in front of `ActionExecutor.execute()`. Denied calls should
return a failed receipt with a repair-oriented explanation. Approval decisions
should be journal events.

Credentials should not enter messages or action parameters. Resolve them at the
executor boundary from an authority grant.

## Add workflows

A workflow chooses which session journal runs next. It should not bypass the
kernel:

- persist the workflow definition and version;
- journal each step and dependency;
- call `runAgentLoop()` for model-controlled leaf work;
- record nondeterministic results rather than recomputing them on resume;
- pass evidence pointers between steps;
- serialize writes to coupled artifacts.

Runtime-authored workflows should freeze the generated definition before
execution and then use the same deterministic journal.

## Add distributed child workers

Persist the child descriptor before scheduling work. Treat `child.started` as
the durable handoff and make worker acquisition idempotent by child session ID.
The returning worker should write its own journal and submit one `ChildResult`
to the parent.
