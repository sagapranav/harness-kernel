# API index

One line per exported symbol, grouped by subpath. The root import re-exports
every portable module below; `/node` must be imported explicitly. Full
signatures live in the shipped source and `.d.ts` files.

## `…/protocol` — canonical types (no runtime code)

- `CanonicalMessage`, `MessageRole`, `Metadata` — provider-neutral message envelope.
- `ContentBlock` = `TextBlock` | `ImageBlock` | `FileBlock` | `ToolCallBlock` | `ToolResultBlock` | `ReasoningBlock` | `ProviderBlock` — message content.
- `ReasoningBlock` / `ReasoningDetail` — model reasoning; `details` preserves provider-native `reasoning_details` (signatures/encrypted content) verbatim for lossless, must-return round-trip.
- `ArtifactRef` — SHA-256 content address (`sha256`, `uri`, `bytes`, `mediaType`).
- `ToolDefinition`, `ProviderRef`, `ImmutableRunConfig` — versioned run configuration.
- `NormalizedModelResponse`, `ModelTelemetry`, `TokenUsage`, `ModelStopReason` — normalized model output.
- `ModelStreamEvent` — incremental model output deltas for live projections (text, reasoning, tool-call deltas, completion).
- `JournalEvent`, `AppendEventInput`, `EventCategory` — event envelope.
- `ActionInvocation`, `ActionReceipt`, `ActionStatus` — tool-effect intent and receipt.
- `EvidenceClaim` — verifiable claim with evidence references.
- `SessionDescriptor`, `ChildResult` — session identity and child conclusions (`noneFound` supported).
- `ContextProjection`, `ContextCompaction` — model-facing context shapes.
- `LoopOutcome` — `completed` | `checkpointed` | `failed` | `cancelled` | `limited`.

## `…/journal` — append-only session log

- `JournalStore` — `append` (atomic `expectedHeadId` compare-and-append), `read`, `head`.
- `AppendOptions`, `JournalReadOptions` (`afterSequence`/`throughSequence`) — call options.
- `JournalConflictError` — thrown on a stale `expectedHeadId`.
- `MemoryJournalStore` — linearizing in-memory reference implementation.
- `createJournalEvent`, `assertExpectedJournalHead`, `selectJournalEvents`, `validateChain`, `assertSessionId`, `ValidateChainOptions` — adapter-building helpers.

## `…/execution` — fenced single-writer session leases

- `FencedJournalStore` — `JournalStore` plus `acquireExecutionLease` / `renewExecutionLease` / `releaseExecutionLease` / `appendFenced` (token checked atomically with append).
- `ExecutionLease`, `AcquireExecutionLeaseRequest` — lease shapes with monotonic `fencingToken`.
- `ExecutionLeaseConflictError` — thrown by a stale or expired writer.
- `bindExecutionLease(journal, lease)` — presents fenced appends through the plain `JournalStore` interface the loop consumes.
- `MemoryFencedJournalStore` — single-instance reference implementation.

## `…/artifacts` — content-addressed payload offloading

- `ArtifactStore` — `put` / `get` / `has` with SHA-256 addressing and verified reads.
- `PutArtifactOptions`, `ArtifactIntegrityError` — put metadata; corruption failure.
- `artifactReference`, `artifactBytes`, `assertArtifactRef` — reference construction and validation helpers.
- `MemoryArtifactStore` — reference implementation.

## `…/conformance` — executable adapter contracts

- `checkHarnessStorage(storage, runtime?)` / `assertStorageConformance` — full storage-bundle suite.
- `checkOrchestration({adapter, queue, journal?, runtime?})` / `assertOrchestrationConformance` — queue + fenced-journal suite (pass the `FencedJournalStore` itself; the expiry check needs an advancing clock).
- `checkJournalStore`, `checkArtifactStore`, `checkProjectionStore`, `checkSessionCatalog`, `checkWorkQueue`, `checkFencedJournalStore`, `checkRuntimeServices` — per-port checks.
- `ConformanceCheck`, `StorageConformanceReport`, `OrchestrationConformanceReport`, `StorageConformanceError`, `OrchestrationConformanceError`, `CheckOrchestrationOptions` — report shapes.

## `…/json` — durable JSON discipline

- `assertJsonSerializable` — rejects values that cannot round-trip through JSON.
- `cloneJson` — defensive deep copy.
- `canonicalJson` — stable key-ordered serialization for content hashing.
- `jsonEqual` — semantic equality via canonical form.

## `…/projection` — context and cold views

- `EVENT_TYPES` — canonical event-name constants (see docs/EVENTS.md).
- `projectContext(sessionId, events, options?)` — model-facing context; honors the latest valid, boundary-safe compaction and keeps only the latest tool result per call.
- `messageEvent`, `compactionEvent` — append-input factories.
- `compactionBoundaryError(sessionId, events, throughEventId)` — null when a compaction boundary is safe.
- `foldProjection`, `ProjectionDefinition`, `ProjectionSnapshot`, `assertProjectionSnapshot` — incremental cold projections over raw events.
- `ProjectionStore`, `MemoryProjectionStore` — replaceable snapshot storage.
- `ProjectContextOptions` — inherited parent messages/evidence for children.

## `…/providers` — OpenAI/Anthropic adapters

- `fromOpenAIResponse`, `fromOpenAIChatCompletion`, `fromAnthropicMessage` — normalize provider payloads (options: `preserveRawResponse`, `rawArtifact`, `preserveProviderMetadata`, `runtime`).
- `toOpenAIInput`, `toAnthropicInput` — encode canonical messages to wire shapes; consecutive tool messages merge into one Anthropic user message.
- `toOpenAIChatInput`, `toOpenAIChatTools` — encode messages and tool definitions for Chat Completions / OpenRouter requests.
- `inlineArtifactBytes(messages, artifacts)` — resolve image/file `ArtifactRef`s to inline base64 (including images nested in tool results) so the encoders can emit a provider image payload; call it in a `ModelInvoker` before encoding.
- `sseJsonEvents(byteStream)` — parse an SSE byte stream into JSON chunks (skips heartbeats, ends on `[DONE]`).
- `createChatCompletionStreamAccumulator()` / `ChatCompletionStreamAccumulator` — fold OpenAI-style stream chunks into the complete response shape while emitting `ModelStreamEvent`s.
- `ProviderEncodeOptions` — `unencodable: "throw" | "describe"` (explicit placeholder downgrade); `imageDetail: "auto" | "low" | "high"` sets OpenAI image fidelity (`"low"` ≈ 3× fewer image tokens; ignored by Anthropic).
- `ProviderEncodingError` — thrown instead of silently dropping content.
- `NormalizeProviderOptions`, `AnthropicInput` — option and result shapes.

## `…/runtime` — injectable host services

- `RuntimeServices` — `createId`, `nowIso`, `sha256`.
- `defaultRuntime` — Web Crypto implementation; `createId`, `nowIso`, `sha256` are its bound conveniences.

## `…/loop` — the provider-neutral agent loop

- `runAgentLoop(options)` — repair crash boundaries, then model → tools → model with compare-and-append writes; throws `JournalConflictError` on a foreign write.
- `AgentLoopOptions` — `sessionId`, `config`, `journal`, `model`, `actions`, plus hooks: `maxTurns` (default 100), `signal`, `beforeTurn`, `shouldCheckpoint`, `project`, `runtime`, `reconcileAction`, `modelRetryDelayMs`, `onModelStream`.
- `ModelInvoker`, `ModelRequest`, `ActionExecutor` — the injected policy and action surfaces; `ModelRequest.onStream` is the sink a streaming invoker forwards deltas to.
- `inspectActionState(events)` / `ActionStateInspection` — crash-boundary inspection (`unstartedCalls`, `unresolved`, `missingResults`).
- `appendActionReconciliation(journal, invocation, receipt)` — record a host-established terminal receipt outside the loop.

## `…/work` — queue, leases, worker host

- `WorkQueue` — `enqueue` (idempotent/immutable), `get`, `claim`, `heartbeat`, `complete`, `checkpoint`, `fail`, `cancel`.
- `WorkItem`, `WorkDeliveryPolicy`, `WorkRecord`, `WorkState`, `WorkLease`, `ActiveWorkLease` — durable work shapes.
- `ClaimWorkRequest`, `CompleteWorkInput`, `CheckpointWorkInput`, `FailWorkInput`, `WorkCompletion`, `WorkFailure`, `WorkCheckpoint`, `WorkCancellation` — transition inputs/records.
- `WorkItemConflictError`, `WorkLeaseConflictError` — conflicting enqueue; stale lease.
- `WorkerHost` / `WorkerHostOptions` — one bounded delivery per `runOne()`; outcome `idle` | `processed` | `lease_lost`.
- `WorkerRunOutcome`, `WorkResolution`, `WorkHandler`, `WorkHandlerContext` — handler contract (`heartbeat()` extends the visibility lease).
- `MemoryWorkQueue`, `assertWorkItem` — reference queue and validation.

## `…/orchestration` — session-to-queue dispatch

- `SessionWorkDispatcher` — `dispatch` / `forkAndDispatch` with deterministic work IDs and crash-recoverable forks.
- `createSessionRunWork(session, options?)` — builds the `session:<id>:run` work item.
- `DEFAULT_AGENT_WORK_POLICY` — 3 attempts per segment, 12 continuations.
- `SessionRunPayload`, `SessionRunWorkOptions`, `DispatchedSessionRun` — shapes.

## `…/sessions` — configs, sessions, forks

- `SessionManager` — `create`, `fork`, `completeChild`, `project` (inherited-context projection for children).
- `SessionCatalog`, `MemorySessionCatalog` — write-once config/descriptor storage.
- `CreateSessionOptions`, `ForkSessionOptions` — creation options; `ForkSessionOptions.linkInParent: false` skips the parent `child.started` write when forking inside the parent's own running loop.
- `assertRunConfig`, `assertSessionDescriptor`, `assertChildResult` — validation helpers.

## `…/storage` — bundles and profiles

- `HarnessStorage` — the four ports plus a `StorageProfile`.
- `StorageProfile`, `StorageComponentProfile`, `StorageDurability`, `StorageCoordination` — per-port operational declarations.
- `createMemoryStorage(runtime?)` — complete in-memory bundle.

## `…/telemetry` — built-in cold projection

- `telemetryProjection` / `TelemetrySummary` — rebuildable usage/action/outcome aggregates for `foldProjection`.

## `…/node` — Node-only filesystem adapters

- `createFileStorage(rootDirectory, runtime?)` — durable filesystem bundle.
- `JsonlJournalStore` — one JSONL file per session; single instance per root; heals torn tails; O(1) cached appends.
- `FileArtifactStore`, `FileProjectionStore`, `FileSessionCatalog` — filesystem ports.
- `renderSessionViewer(storage, sessionId, options?)` — self-contained HTML transcript viewer (Overview / Transcript / Raw tabs, sub-agent navigation, inline images) for a session and its sub-agents.
- `collectSessionBundle(storage, sessionId, options?)` / `ViewerBundle`, `ViewerSession`, `SessionViewerOptions` — the viewer's data as a plain object (sessions, telemetry, inlined images) for custom rendering.
