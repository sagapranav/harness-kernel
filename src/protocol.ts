/**
 * The stable semantic layer shared by provider adapters, journals, loops, and
 * projections. Provider payloads belong behind adapters; unknown semantics can
 * be retained in `provider` content blocks or content-addressed artifacts.
 */

export type Metadata = Record<string, unknown>;

export interface ArtifactRef {
  /** Lowercase SHA-256 hex digest. */
  sha256: string;
  /** Portable content-addressed identifier, normally `sha256:<digest>`. */
  uri: string;
  bytes: number;
  mediaType: string;
  name?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  providerMetadata?: Metadata;
}

export interface ImageBlock {
  type: "image";
  artifact: ArtifactRef;
  alt?: string;
  providerMetadata?: Metadata;
}

export interface FileBlock {
  type: "file";
  artifact: ArtifactRef;
  providerMetadata?: Metadata;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  inputParseError?: string;
  providerMetadata?: Metadata;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  name?: string;
  isError: boolean;
  content: ContentBlock[];
  providerMetadata?: Metadata;
}

/**
 * One provider-native reasoning fragment, preserved verbatim. Providers that
 * expose reasoning through an OpenAI-compatible API (OpenRouter and others)
 * return these as `reasoning_details`, and several require them returned
 * unchanged on the next turn — an Anthropic thinking `signature` or an OpenAI
 * `data`/encrypted payload — or tool use across turns breaks. Treat this as
 * opaque: keep every field, do not synthesize or edit it.
 */
export interface ReasoningDetail {
  /** e.g. `reasoning.text`, `reasoning.encrypted`, `reasoning.summary`. */
  type: string;
  /** Provider format tag, e.g. `anthropic-claude-v1`, `openai-responses-v1`. */
  format?: string;
  /** Human-visible reasoning text, when the provider exposes it. */
  text?: string;
  /** Opaque signature that must be returned verbatim (Anthropic-style). */
  signature?: string;
  /** Opaque encrypted payload that must be returned verbatim (OpenAI-style). */
  data?: string;
  /** Provider item identifier, when present. */
  id?: string;
  /** Ordering index within the turn. */
  index?: number;
  [key: string]: unknown;
}

export interface ReasoningBlock {
  type: "reasoning";
  /** Human-visible reasoning text, for display and plaintext round-trip. */
  text?: string;
  redacted?: boolean;
  /** Opaque signature (Anthropic direct API). Also carried in `details`. */
  signature?: string;
  /**
   * Provider-native reasoning fragments preserved verbatim for lossless
   * round-trip, including the opaque signatures/encrypted content a provider
   * requires returned. First-class so it survives even when
   * `providerMetadata` is stripped.
   */
  details?: ReasoningDetail[];
  providerMetadata?: Metadata;
}

export interface ProviderBlock {
  type: "provider";
  provider: string;
  providerType: string;
  placement?: "content" | "item";
  raw?: unknown;
  rawArtifact?: ArtifactRef;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | FileBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock
  | ProviderBlock;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalMessage {
  id: string;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: string;
  provider?: string;
  metadata?: Metadata;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderRef {
  /** Extensible identifier: `openai`, `anthropic`, or an adapter-defined name. */
  provider: string;
  model: string;
  endpoint?: string;
}

export interface ImmutableRunConfig {
  id: string;
  version: number;
  createdAt: string;
  provider: ProviderRef;
  systemPrompt?: string;
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Metadata;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ModelStopReason =
  | "end"
  | "tool_use"
  | "length"
  | "content_filter"
  | "pause"
  | "error"
  | "aborted"
  | "unknown";

export interface ModelTelemetry {
  provider: string;
  model: string;
  latencyMs: number;
  usage: TokenUsage;
  stopReason: ModelStopReason;
  requestId?: string;
  retries?: number;
  costUsd?: number;
  servedModel?: string;
  providerMetadata?: Metadata;
}

/**
 * Incremental model output for UI and broadcast projections. Streaming never
 * replaces the journal: the loop records only the complete normalized
 * response, so a consumer that missed the stream loses nothing durable.
 */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; id: string; name: string }
  | { type: "tool_call_arguments_delta"; id: string; delta: string }
  | { type: "stream_completed"; finishReason?: string };

export interface NormalizedModelResponse {
  message: CanonicalMessage;
  telemetry: ModelTelemetry;
  /** Exact provider response, inline or offloaded, for lossless audit/replay. */
  providerSnapshot?: {
    provider: string;
    raw?: unknown;
    rawArtifact?: ArtifactRef;
  };
}

export type EventCategory = "context" | "trace" | "control";

/**
 * The envelope is deliberately open on `type` and `data`. Readers must retain
 * unknown events so older runtimes never destroy newer events during replay.
 */
export interface JournalEvent<TData = Record<string, unknown>> {
  id: string;
  sessionId: string;
  sequence: number;
  parentId: string | null;
  timestamp: string;
  category: EventCategory;
  type: string;
  version: number;
  turnId: string | null;
  affectsContext: boolean;
  data: TData;
}

export interface AppendEventInput<TData = Record<string, unknown>> {
  category: EventCategory;
  type: string;
  version?: number;
  turnId?: string | null;
  affectsContext?: boolean;
  data: TData;
}

export interface ActionInvocation {
  invocationId: string;
  sessionId: string;
  turnId: string;
  call: ToolCallBlock;
  idempotencyKey?: string;
  authorityGrant?: string;
  expectedPostcondition?: string;
}

export type ActionStatus = "succeeded" | "failed" | "pending" | "unknown";

export interface ActionReceipt {
  invocationId: string;
  status: ActionStatus;
  content: ContentBlock[];
  externalOperationId?: string;
  observedPostcondition?: string;
  evidenceRefs?: ArtifactRef[];
  metadata?: Metadata;
}

export interface EvidenceClaim {
  claimId: string;
  text: string;
  status: "unverified" | "verified" | "refuted";
  evidenceRefs: ArtifactRef[];
  verifiedAt?: string;
  verifier?: string;
}

export interface SessionDescriptor {
  id: string;
  configId: string;
  createdAt: string;
  parentSessionId?: string;
  forkEventId?: string;
  purpose?: string;
  metadata?: Metadata;
}

export interface ChildResult {
  childSessionId: string;
  status: "completed" | "failed" | "cancelled";
  conclusion?: string;
  noneFound?: boolean;
  confidence?: number;
  evidenceRefs: ArtifactRef[];
  artifactRefs: ArtifactRef[];
  metadata?: Metadata;
}

export interface ContextProjection {
  sessionId: string;
  messages: CanonicalMessage[];
  rawThroughEventId: string | null;
  rawThroughSequence: number;
  compactionEventId: string | null;
  evidenceRefs: ArtifactRef[];
}

export interface ContextCompaction {
  summarizesThroughEventId: string;
  summary: CanonicalMessage;
  evidenceRefs: ArtifactRef[];
  /**
   * `including_inherited` lets a child compact the parent projection it
   * inherited as well as its own local events.
   */
  scope: "local" | "including_inherited";
  projectorVersion: number;
  model?: ProviderRef;
}

export type LoopOutcome =
  | { status: "completed"; turns: number }
  | { status: "checkpointed"; turns: number; reason: string }
  | { status: "failed"; turns: number; error: string }
  | { status: "cancelled"; turns: number }
  | { status: "limited"; turns: number; limit: number };
