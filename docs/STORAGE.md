# Storage and runtime ports

Harness Kernel defines persistence semantics, not a database choice. The same
protocol can run over memory, a local filesystem, SQLite, Postgres, object
storage, browser storage, a worker-local service, or a remote persistence API.

## Portable and host-specific imports

The root package and every subpath except `/node` contain no Node built-ins:
`…/protocol`, `…/journal`, `…/execution`, `…/artifacts`, `…/conformance`,
`…/json`, `…/projection`, `…/providers`, `…/runtime`, `…/loop`, `…/work`,
`…/orchestration`, `…/sessions`, `…/storage`, and `…/telemetry` all run in
browsers, edge runtimes, and workers with ES2022 and Web Crypto.

Node filesystem implementations are isolated behind:

```ts
import { createFileStorage } from "@sagapranav/harness-kernel/node";

const storage = createFileStorage("./harness-data");
```

Do not import `/node` from browser, edge, worker, or other non-Node bundles.

## Complete storage bundle

`HarnessStorage` groups four independently replaceable ports:

| Port              | Required semantics                                                |
| ----------------- | ----------------------------------------------------------------- |
| `JournalStore`    | Linear per-session log and atomic conditional append              |
| `ArtifactStore`   | SHA-256 addressing, idempotent put, verified immutable bytes      |
| `ProjectionStore` | Replaceable versioned snapshots; never authoritative              |
| `SessionCatalog`  | Write-once configs and descriptors; identical puts are idempotent |

The ports may use different backends. A common production layout is:

- Postgres or a transactional KV store for journals and session metadata;
- object storage for artifacts;
- Redis, SQLite, a search index, or normal database tables for projections.

The raw journal and referenced artifacts are the recovery boundary.
Projections may be deleted and rebuilt.

## Storage profiles

Each bundle carries a descriptive `StorageProfile`. Capabilities are declared
per port because one harness may mix a distributed journal, object artifacts,
ephemeral projections, and a transactional session catalog:

- `adapter`: the concrete implementation;
- `durability`: `ephemeral` or `durable`;
- `coordination`: `single_instance`, `single_process`, `multi_process`, or
  `distributed`.

Profiles are operational declarations, not proof. Run conformance checks
against the actual deployed adapter.

```ts
import {
  assertStorageConformance,
  checkHarnessStorage,
} from "@sagapranav/harness-kernel/conformance";

const report = await checkHarnessStorage(freshTestStorage);
assertStorageConformance(report);
```

The suite writes records. Use a disposable database, isolated namespace, or CI
tenant. It checks append conflicts, concurrent conditional-append exclusivity,
concurrent linearization, defensive copies, content integrity, replaceable
projections, and immutable catalog values. Adapter-building helpers —
`createJournalEvent`, `assertExpectedJournalHead`, `selectJournalEvents`,
`validateChain`, `artifactReference`, `artifactBytes`, and the `canonicalJson`
/ `jsonEqual` utilities — implement the fiddly parts of these contracts so a
new adapter mostly supplies I/O.

## Journal implementations

`expectedHeadId` is not an advisory preflight. A durable implementation must
compare the current head and append the next event atomically.

For SQL, use one transaction and protect a per-session head row, or use a
conditional update whose affected-row count proves ownership of the next
sequence. A unique key on `(session_id, sequence)` is necessary but is not by
itself sufficient to implement `expectedHeadId`.

The included `JsonlJournalStore` is a single-instance reference adapter. It
serializes calls made through that instance, syncs appended bytes, and keeps a
per-session tail cache so steady-state appends do not re-read the file. A
partial final line left by a crash mid-write is ignored by reads and truncated
before the next append; corruption anywhere before the final line still fails
loudly. It is not a distributed lock and must not have multiple writers for
one root.

## Artifact implementations

The digest is part of the protocol. An adapter must:

1. snapshot caller bytes before awaiting external work;
2. compute SHA-256 over those exact bytes;
3. make repeated puts idempotent;
4. verify digest and byte count on reads;
5. return a fresh byte array rather than mutable internal state.

Provider snapshots and large tool outputs can be offloaded before their
references are appended to the journal.

### Images, files, and other large payloads

Binary and large payloads never live inside events. The flow is always the
same:

1. `artifacts.put(bytes, { mediaType })` stores the bytes and returns an
   `ArtifactRef` — the SHA-256 digest, a `sha256:<digest>` URI, the byte
   count, and the media type. Identical bytes always produce the same
   reference, so puts are idempotent and duplicates are free.
2. The event carries only that reference, inside an `image` or `file` content
   block (`{ type: "image", artifact: ref }`). Journals stay small and
   text-only.
3. `artifacts.get(ref)` resolves the bytes back and re-checks the digest and
   byte count, so silent corruption fails loudly.

`createFileStorage` writes the bytes to
`<root>/artifacts/<first-two-hex-of-digest>/<digest>` with an atomic,
idempotent hard-link write; `createMemoryStorage` keeps them in memory. Either
way the journal only ever holds the reference.

Encoding an image or file back to a provider is a separate step: a provider
needs a URL, a file id, or base64, and the synchronous encoders cannot read the
artifact store. Resolve the bytes first with
`inlineArtifactBytes(messages, artifacts)` — it fetches each image/file's bytes
(including images nested in tool results) and attaches base64 the encoders emit
as a provider image payload. Anthropic accepts the image inside the tool result
directly; OpenAI cannot, so a tool-produced image is relayed as a following
user message. Without resolution the encoders throw (or emit an explicit
placeholder under `unencodable: "describe"`) rather than dropping the image. See
[PROVIDERS.md](PROVIDERS.md).

## Projection implementations

Projection storage is a cache. Replacing a snapshot is allowed. Treat the tuple
`(sessionId, name, version)` as its identity and retain the raw-journal boundary
`(throughSequence, throughEventId)` with the state.

Never make progress in the raw journal depend on projection availability.

## Session catalog implementations

Configs and session descriptors are immutable values. An identical repeated
put succeeds; a different value under the same ID fails. Implement this with a
unique key plus semantic comparison or a canonical content hash.

## Runtime services

`RuntimeServices` supplies:

- opaque ID creation;
- wall-clock ISO timestamps;
- SHA-256 hashing.

The default uses Web Crypto and therefore works in modern Node, browsers, edge
runtimes, and workers. Inject a replacement for deterministic tests, virtual
clocks, host-provided identity, FIPS-specific hashing, or runtimes without Web
Crypto.

Pass the same runtime instance to storage, `SessionManager`,
`runAgentLoop({ runtime })`, and provider normalization options when complete
determinism is required.

Runtime services must not contain secrets and must not silently weaken SHA-256
content addressing.

## Operational execution state

The work queue is intentionally not a fifth `HarnessStorage` port. Queue
delivery attempts, visibility leases, continuations, and dead-letter state are
operational execution state with different consistency and lifecycle needs.
Use `WorkQueue` for that plane.

Multi-machine workers also need `FencedJournalStore`. Queue fencing prevents a
stale acknowledgement; journal fencing prevents a stale process from writing
semantic history after another worker owns the session. See
[ORCHESTRATION.md](ORCHESTRATION.md).
