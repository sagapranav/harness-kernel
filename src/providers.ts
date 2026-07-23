import { assertArtifactRef, type ArtifactStore } from "./artifacts.js";
import { assertJsonSerializable } from "./json.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import type {
  ArtifactRef,
  CanonicalMessage,
  ContentBlock,
  ImageBlock,
  Metadata,
  ModelStopReason,
  ModelStreamEvent,
  NormalizedModelResponse,
  ProviderBlock,
  TokenUsage,
  ToolDefinition,
} from "./protocol.js";

type UnknownRecord = Record<string, unknown>;

export interface NormalizeProviderOptions {
  model: string;
  latencyMs?: number;
  requestId?: string;
  preserveUnknownBlocks?: boolean;
  preserveProviderMetadata?: boolean;
  /** Prefer this over inline raw responses when an ArtifactStore is available. */
  rawArtifact?: ArtifactRef;
  /** Defaults to true when `rawArtifact` is absent. */
  preserveRawResponse?: boolean;
  /** Host identity/time services for generated canonical IDs and timestamps. */
  runtime?: RuntimeServices;
}

export interface ProviderEncodeOptions {
  /**
   * How to handle canonical content the target provider cannot express.
   * The default rejects the encode so provider input is never weakened
   * implicitly; `"describe"` replaces each such block with a deterministic
   * text placeholder naming the block type and any artifact reference it
   * carried — an explicit downgrade, never a silent omission. Structural
   * errors (malformed messages, wrong roles) always throw.
   */
  unencodable?: "throw" | "describe";
}

type UnencodableMode = NonNullable<ProviderEncodeOptions["unencodable"]>;

export class ProviderEncodingError extends Error {
  constructor(
    readonly provider: string,
    readonly blockType: string,
    message?: string,
  ) {
    super(
      message ??
        `${provider} adapter cannot encode canonical ${blockType} block`,
    );
    this.name = "ProviderEncodingError";
  }
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

function assertNormalizationInput(
  raw: unknown,
  options: NormalizeProviderOptions,
): void {
  assertJsonSerializable(raw, "provider response");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("provider response must be a JSON object");
  }
  if (typeof options.model !== "string" || options.model.length === 0) {
    throw new TypeError("normalization model must be a non-empty string");
  }
  if (
    options.latencyMs !== undefined &&
    (typeof options.latencyMs !== "number" ||
      !Number.isFinite(options.latencyMs) ||
      options.latencyMs < 0)
  ) {
    throw new TypeError(
      "normalization latencyMs must be a non-negative finite number",
    );
  }
  if (
    options.requestId !== undefined &&
    typeof options.requestId !== "string"
  ) {
    throw new TypeError("normalization requestId must be a string");
  }
  for (const key of [
    "preserveUnknownBlocks",
    "preserveProviderMetadata",
    "preserveRawResponse",
  ] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new TypeError(`${key} must be a boolean`);
    }
  }
  if (options.rawArtifact !== undefined) assertArtifactRef(options.rawArtifact);
}

function providerMetadata(
  raw: unknown,
  options: NormalizeProviderOptions,
): Metadata | undefined {
  return options.preserveProviderMetadata === false ? undefined : { raw };
}

function withProviderMetadata<T extends object>(
  value: T,
  raw: unknown,
  options: NormalizeProviderOptions,
): T & { providerMetadata?: Metadata } {
  const metadata = providerMetadata(raw, options);
  return metadata === undefined
    ? value
    : { ...value, providerMetadata: metadata };
}

function parseArguments(value: unknown): { input: unknown; error?: string } {
  if (typeof value !== "string") return { input: value ?? {} };
  try {
    return { input: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      input: { raw: value },
      error:
        error instanceof Error ? error.message : "invalid JSON tool arguments",
    };
  }
}

function stopReason(value: unknown): ModelStopReason {
  switch (value) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
    case "completed":
      return "end";
    case "tool_calls":
    case "tool_use":
      return "tool_use";
    case "length":
    case "max_tokens":
    case "max_output_tokens":
    case "model_context_window_exceeded":
    case "incomplete":
      return "length";
    case "content_filter":
    case "refusal":
      return "content_filter";
    case "pause_turn":
      return "pause";
    case "cancelled":
      return "aborted";
    case "failed":
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function message(
  provider: string,
  content: ContentBlock[],
  runtime: RuntimeServices,
  id?: string,
): CanonicalMessage {
  return {
    id: id ?? runtime.createId("msg"),
    role: "assistant",
    content,
    createdAt: runtime.nowIso(),
    provider,
  };
}

function unknownBlock(
  provider: string,
  raw: unknown,
  preserve: boolean,
  placement: ProviderBlock["placement"],
): ContentBlock[] {
  if (!preserve) return [];
  return [
    {
      type: "provider",
      provider,
      providerType: string(record(raw).type) ?? "unknown",
      placement,
      raw,
    },
  ];
}

function providerSnapshot(
  provider: string,
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse["providerSnapshot"] {
  if (options.rawArtifact !== undefined) {
    return { provider, rawArtifact: options.rawArtifact };
  }
  if (options.preserveRawResponse === false) return undefined;
  return { provider, raw };
}

function compactProviderTelemetry(root: UnknownRecord): Metadata {
  return Object.fromEntries(
    [
      ["object", root.object],
      ["status", root.status],
      ["error", root.error],
      ["incompleteDetails", root.incomplete_details],
      ["previousResponseId", root.previous_response_id],
      ["serviceTier", root.service_tier],
      ["stopSequence", root.stop_sequence],
    ].filter((entry) => entry[1] !== undefined),
  );
}

function optionalString(key: string, value: string | undefined): UnknownRecord {
  return value === undefined ? {} : { [key]: value };
}

/** Normalizes an OpenAI Responses API response without depending on its SDK. */
export function fromOpenAIResponse(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  assertNormalizationInput(raw, options);
  const runtime = options.runtime ?? defaultRuntime;
  const root = record(raw);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;
  let canonicalMessageId: string | undefined;
  let refused = false;

  for (const itemValue of list(root.output)) {
    const item = record(itemValue);
    switch (item.type) {
      case "message":
        canonicalMessageId ??= string(item.id);
        for (const partValue of list(item.content)) {
          const part = record(partValue);
          if (part.type === "output_text" && typeof part.text === "string") {
            content.push(
              withProviderMetadata(
                { type: "text", text: part.text },
                partValue,
                options,
              ),
            );
          } else if (
            part.type === "refusal" &&
            typeof part.refusal === "string"
          ) {
            refused = true;
            content.push(
              withProviderMetadata(
                { type: "text", text: part.refusal },
                partValue,
                options,
              ),
            );
          } else {
            content.push(
              ...unknownBlock("openai", partValue, preserve, "content"),
            );
          }
        }
        break;
      case "function_call": {
        const parsed = parseArguments(item.arguments);
        content.push(
          withProviderMetadata(
            {
              type: "tool_call",
              id:
                string(item.call_id) ??
                string(item.id) ??
                runtime.createId("call"),
              name: string(item.name) ?? "unknown_tool",
              input: parsed.input,
              ...(parsed.error === undefined
                ? {}
                : { inputParseError: parsed.error }),
            },
            itemValue,
            options,
          ),
        );
        break;
      }
      case "reasoning": {
        const summary = list(item.summary)
          .map((part) => string(record(part).text))
          .filter((part): part is string => part !== undefined)
          .join("\n");
        content.push(
          withProviderMetadata(
            {
              type: "reasoning",
              ...(summary.length === 0
                ? { redacted: true }
                : { text: summary }),
            },
            itemValue,
            options,
          ),
        );
        break;
      }
      default:
        content.push(...unknownBlock("openai", itemValue, preserve, "item"));
    }
  }

  const usage = record(root.usage);
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  const incompleteReason = record(root.incomplete_details).reason;
  const normalizedStopReason: ModelStopReason = refused
    ? "content_filter"
    : content.some((block) => block.type === "tool_call")
      ? "tool_use"
      : root.status === "incomplete"
        ? stopReason(incompleteReason)
        : stopReason(root.status);
  const response: NormalizedModelResponse = {
    message: message(
      "openai",
      content,
      runtime,
      canonicalMessageId ?? string(root.id),
    ),
    telemetry: {
      provider: "openai",
      model: options.model,
      latencyMs: options.latencyMs ?? 0,
      stopReason: normalizedStopReason,
      usage: {
        inputTokens: tokenCount(usage.input_tokens),
        outputTokens: tokenCount(usage.output_tokens),
        cacheReadTokens: tokenCount(inputDetails.cached_tokens),
        cacheWriteTokens: tokenCount(inputDetails.cache_write_tokens),
        reasoningTokens: tokenCount(outputDetails.reasoning_tokens),
      },
      providerMetadata: compactProviderTelemetry(root),
      ...optionalString("servedModel", string(root.model)),
      ...optionalString("requestId", options.requestId ?? string(root.id)),
    },
  };
  const snapshot = providerSnapshot("openai", raw, options);
  return snapshot === undefined
    ? response
    : { ...response, providerSnapshot: snapshot };
}

/** Normalizes the older OpenAI-compatible Chat Completions response shape. */
export function fromOpenAIChatCompletion(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  assertNormalizationInput(raw, options);
  const runtime = options.runtime ?? defaultRuntime;
  const root = record(raw);
  const choice = record(list(root.choices)[0]);
  const source = record(choice.message);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;
  let refused = false;

  // Empty-string content carries no semantics and would re-encode as an
  // empty text block some providers reject.
  if (typeof source.content === "string" && source.content.length > 0) {
    content.push({ type: "text", text: source.content });
  } else if (Array.isArray(source.content)) {
    for (const partValue of source.content) {
      const part = record(partValue);
      if (part.type === "text" && typeof part.text === "string") {
        content.push(
          withProviderMetadata(
            { type: "text", text: part.text },
            partValue,
            options,
          ),
        );
      } else {
        content.push(
          ...unknownBlock("openai-chat", partValue, preserve, "content"),
        );
      }
    }
  }
  if (typeof source.refusal === "string") {
    refused = true;
    content.push({ type: "text", text: source.refusal });
  }
  for (const callValue of list(source.tool_calls)) {
    const call = record(callValue);
    const fn = record(call.function);
    const parsed = parseArguments(fn.arguments);
    content.push(
      withProviderMetadata(
        {
          type: "tool_call",
          id: string(call.id) ?? runtime.createId("call"),
          name: string(fn.name) ?? "unknown_tool",
          input: parsed.input,
          ...(parsed.error === undefined
            ? {}
            : { inputParseError: parsed.error }),
        },
        callValue,
        options,
      ),
    );
  }
  // OpenRouter and several compatible endpoints use `reasoning`; DeepSeek-style
  // endpoints use `reasoning_content`.
  const reasoning =
    string(source.reasoning_content) ?? string(source.reasoning);
  if (reasoning !== undefined && reasoning.length > 0) {
    content.push({
      type: "reasoning",
      text: reasoning,
      providerMetadata: { raw: reasoning },
    });
  }

  const usage = record(root.usage);
  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  const response: NormalizedModelResponse = {
    message: message(
      "openai-chat",
      content,
      runtime,
      string(source.id) ?? string(root.id),
    ),
    telemetry: {
      provider: "openai-chat",
      model: options.model,
      latencyMs: options.latencyMs ?? 0,
      stopReason: refused ? "content_filter" : stopReason(choice.finish_reason),
      usage: {
        inputTokens: tokenCount(usage.prompt_tokens),
        outputTokens: tokenCount(usage.completion_tokens),
        cacheReadTokens: tokenCount(promptDetails.cached_tokens),
        cacheWriteTokens: tokenCount(promptDetails.cache_write_tokens),
        reasoningTokens: tokenCount(completionDetails.reasoning_tokens),
      },
      providerMetadata: compactProviderTelemetry(root),
      // OpenRouter reports the request cost inside usage.
      ...(typeof usage.cost === "number" &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0
        ? { costUsd: usage.cost }
        : {}),
      ...optionalString("servedModel", string(root.model)),
      ...optionalString("requestId", options.requestId ?? string(root.id)),
    },
  };
  const snapshot = providerSnapshot("openai-chat", raw, options);
  return snapshot === undefined
    ? response
    : { ...response, providerSnapshot: snapshot };
}

/** Normalizes an Anthropic Messages API response without depending on its SDK. */
export function fromAnthropicMessage(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  assertNormalizationInput(raw, options);
  const runtime = options.runtime ?? defaultRuntime;
  const root = record(raw);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;

  for (const blockValue of list(root.content)) {
    const block = record(blockValue);
    switch (block.type) {
      case "text":
        content.push(
          withProviderMetadata(
            { type: "text", text: string(block.text) ?? "" },
            blockValue,
            options,
          ),
        );
        break;
      case "tool_use":
        content.push(
          withProviderMetadata(
            {
              type: "tool_call",
              id: string(block.id) ?? runtime.createId("call"),
              name: string(block.name) ?? "unknown_tool",
              input: block.input ?? {},
            },
            blockValue,
            options,
          ),
        );
        break;
      case "thinking":
        content.push(
          withProviderMetadata(
            {
              type: "reasoning",
              ...(typeof block.thinking === "string"
                ? { text: block.thinking }
                : {}),
              ...(typeof block.signature === "string"
                ? { signature: block.signature }
                : {}),
            },
            blockValue,
            options,
          ),
        );
        break;
      case "redacted_thinking":
        content.push(
          withProviderMetadata(
            { type: "reasoning", redacted: true },
            blockValue,
            options,
          ),
        );
        break;
      default:
        content.push(
          ...unknownBlock("anthropic", blockValue, preserve, "content"),
        );
    }
  }

  const usage = record(root.usage);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const outputDetails = record(usage.output_tokens_details);
  const reasoningTokens = tokenCount(outputDetails.thinking_tokens);
  const normalizedUsage: TokenUsage = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
  };
  const response: NormalizedModelResponse = {
    message: message("anthropic", content, runtime, string(root.id)),
    telemetry: {
      provider: "anthropic",
      model: options.model,
      latencyMs: options.latencyMs ?? 0,
      stopReason: stopReason(root.stop_reason),
      usage: normalizedUsage,
      providerMetadata: compactProviderTelemetry(root),
      ...optionalString("servedModel", string(root.model)),
      ...optionalString("requestId", options.requestId ?? string(root.id)),
    },
  };
  const snapshot = providerSnapshot("anthropic", raw, options);
  return snapshot === undefined
    ? response
    : { ...response, providerSnapshot: snapshot };
}

function rawMetadata(block: {
  providerMetadata?: Metadata;
}): UnknownRecord | null {
  const raw = record(block.providerMetadata).raw;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as UnknownRecord)
    : null;
}

function encodeMode(options: ProviderEncodeOptions): UnencodableMode {
  if (
    options.unencodable !== undefined &&
    options.unencodable !== "throw" &&
    options.unencodable !== "describe"
  ) {
    throw new TypeError('unencodable must be "throw" or "describe"');
  }
  return options.unencodable ?? "throw";
}

function blockArtifact(block: ContentBlock): ArtifactRef | undefined {
  switch (block.type) {
    case "image":
    case "file":
      return block.artifact;
    case "provider":
      return block.rawArtifact;
    default:
      return undefined;
  }
}

function unencodableText(
  provider: string,
  block: ContentBlock,
  mode: UnencodableMode,
  detail: string,
): string {
  if (mode === "throw") {
    throw new ProviderEncodingError(provider, block.type, detail);
  }
  const label =
    block.type === "provider"
      ? `provider block ${block.provider}/${block.providerType}`
      : `${block.type} block`;
  const ref = blockArtifact(block);
  return ref === undefined
    ? `[unencodable ${label}]`
    : `[unencodable ${label}: ${ref.uri}]`;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function inlineBase64Of(block: { providerMetadata?: Metadata }): string | null {
  const value = record(block.providerMetadata).inlineBase64;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * Resolves image and file blocks that carry only an ArtifactRef into blocks
 * that also carry inline base64 bytes, so the outbound encoders can emit a
 * provider image payload. Fetches each block's bytes from the artifact store
 * (including images nested inside tool_result content) and attaches them under
 * `providerMetadata.inlineBase64`; blocks that already have inline or native
 * provider data are left untouched. Call it in a ModelInvoker before
 * toAnthropicInput()/toOpenAIInput()/toOpenAIChatInput() when a session may
 * carry tool-produced images. Note: the OpenAI APIs cannot place an image
 * inside a tool result, so an image returned by a tool must be relayed to
 * those providers as a following user message; Anthropic accepts it in the
 * tool result directly.
 */
export async function inlineArtifactBytes(
  messages: CanonicalMessage[],
  artifacts: ArtifactStore,
): Promise<CanonicalMessage[]> {
  const inlineBlock = async (block: ContentBlock): Promise<ContentBlock> => {
    if (block.type === "tool_result") {
      return {
        ...block,
        content: await Promise.all(block.content.map(inlineBlock)),
      };
    }
    if (block.type !== "image" && block.type !== "file") return block;
    if (inlineBase64Of(block) !== null) return block;
    const bytes = await artifacts.get(block.artifact);
    return {
      ...block,
      providerMetadata: {
        ...(block.providerMetadata ?? {}),
        inlineBase64: base64FromBytes(bytes),
      },
    };
  };
  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      content: await Promise.all(message.content.map(inlineBlock)),
    })),
  );
}

/** Flattens tool-result content into the single string OpenAI output accepts. */
function openAIResultOutput(
  blocks: ContentBlock[],
  mode: UnencodableMode,
  provider = "openai",
): string {
  return blocks
    .map((block) =>
      block.type === "text"
        ? block.text
        : unencodableText(
            provider,
            block,
            mode,
            block.type === "image"
              ? `${provider} cannot place an image in a tool result; relay tool-produced images as a user message`
              : `${provider} tool-result encoding requires text-only content or an application resolver`,
          ),
    )
    .join("\n");
}

function nativeAnthropicImage(block: {
  providerMetadata?: Metadata;
}): UnknownRecord | null {
  const raw = rawMetadata(block);
  return raw?.type === "image" &&
    typeof raw.source === "object" &&
    raw.source !== null
    ? raw
    : null;
}

/**
 * Anthropic-native image block from a canonical image: its original source if
 * retained, otherwise inline base64 bytes (from inlineArtifactBytes()).
 * Returns null when neither is available.
 */
function anthropicImageBlock(
  block: ImageBlock,
  _mode: UnencodableMode,
): UnknownRecord | null {
  const native = nativeAnthropicImage(block);
  if (native !== null) return native;
  const base64 = inlineBase64Of(block);
  if (base64 !== null) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.artifact.mediaType,
        data: base64,
      },
    };
  }
  return null;
}

function anthropicResultContent(
  blocks: ContentBlock[],
  mode: UnencodableMode,
): string | UnknownRecord[] {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("\n");
  }
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const image = anthropicImageBlock(block, mode);
      if (image !== null) return image;
      return {
        type: "text",
        text: unencodableText(
          "anthropic",
          block,
          mode,
          "tool-result images need inlineArtifactBytes(), a native Anthropic source in provider metadata, or an application base64 resolver",
        ),
      };
    }
    return {
      type: "text",
      text: unencodableText(
        "anthropic",
        block,
        mode,
        `anthropic tool results cannot carry ${block.type} blocks`,
      ),
    };
  });
}

function assertCanonicalForEncoding(
  provider: string,
  messages: CanonicalMessage[],
): void {
  try {
    assertJsonSerializable(messages);
  } catch (error) {
    throw new ProviderEncodingError(
      provider,
      "messages",
      `canonical messages must be durable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(messages)) {
    throw new ProviderEncodingError(
      provider,
      "messages",
      "canonical messages must be an array",
    );
  }

  const validateBlocks = (blocks: unknown, path: string): void => {
    if (!Array.isArray(blocks)) {
      throw new ProviderEncodingError(
        provider,
        "message",
        `${path} must be an array`,
      );
    }
    for (const [index, candidate] of blocks.entries()) {
      const block = record(candidate);
      const location = `${path}[${index}]`;
      const fail = (message: string): never => {
        throw new ProviderEncodingError(
          provider,
          string(block.type) ?? "unknown",
          `${location} ${message}`,
        );
      };
      switch (block.type) {
        case "text":
          if (typeof block.text !== "string") fail("text must be a string");
          break;
        case "image":
        case "file":
          try {
            assertArtifactRef(block.artifact as ArtifactRef);
          } catch (error) {
            fail(
              `artifact is invalid: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (
            block.type === "image" &&
            block.alt !== undefined &&
            typeof block.alt !== "string"
          ) {
            fail("alt must be a string");
          }
          break;
        case "tool_call":
          if (typeof block.id !== "string" || block.id.length === 0)
            fail("id must be a non-empty string");
          if (typeof block.name !== "string" || block.name.length === 0)
            fail("name must be a non-empty string");
          if (!Object.prototype.hasOwnProperty.call(block, "input"))
            fail("input is required");
          if (block.inputParseError !== undefined)
            fail("cannot encode malformed tool arguments");
          break;
        case "tool_result":
          if (
            typeof block.toolCallId !== "string" ||
            block.toolCallId.length === 0
          ) {
            fail("toolCallId must be a non-empty string");
          }
          if (typeof block.isError !== "boolean")
            fail("isError must be a boolean");
          if (block.name !== undefined && typeof block.name !== "string")
            fail("name must be a string");
          validateBlocks(block.content, `${location}.content`);
          break;
        case "reasoning":
          if (block.text !== undefined && typeof block.text !== "string")
            fail("text must be a string");
          if (
            block.redacted !== undefined &&
            typeof block.redacted !== "boolean"
          )
            fail("redacted must be a boolean");
          if (
            block.signature !== undefined &&
            typeof block.signature !== "string"
          ) {
            fail("signature must be a string");
          }
          break;
        case "provider":
          if (typeof block.provider !== "string" || block.provider.length === 0)
            fail("provider must be a non-empty string");
          if (
            typeof block.providerType !== "string" ||
            block.providerType.length === 0
          ) {
            fail("providerType must be a non-empty string");
          }
          if (
            block.placement !== undefined &&
            block.placement !== "content" &&
            block.placement !== "item"
          ) {
            fail("placement is invalid");
          }
          if (block.rawArtifact !== undefined) {
            try {
              assertArtifactRef(block.rawArtifact as ArtifactRef);
            } catch (error) {
              fail(
                `rawArtifact is invalid: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          if (block.raw === undefined && block.rawArtifact === undefined)
            fail("must retain raw data or an artifact");
          break;
        default:
          fail(`has unknown block type ${String(block.type)}`);
      }
    }
  };

  for (const [index, candidate] of messages.entries()) {
    const source = record(candidate);
    if (
      typeof source.id !== "string" ||
      source.id.length === 0 ||
      !["system", "user", "assistant", "tool"].includes(String(source.role)) ||
      typeof source.createdAt !== "string" ||
      Number.isNaN(Date.parse(source.createdAt))
    ) {
      throw new ProviderEncodingError(
        provider,
        "message",
        `messages[${index}] has an invalid canonical envelope`,
      );
    }
    validateBlocks(source.content, `messages[${index}].content`);
  }
}

/**
 * Encodes canonical messages for OpenAI Responses API `input`. Unsupported
 * blocks fail loudly so provider input is never silently weakened, unless the
 * caller opts into explicit `unencodable: "describe"` downgrades.
 */
export function toOpenAIInput(
  messages: CanonicalMessage[],
  options: ProviderEncodeOptions = {},
): UnknownRecord[] {
  const mode = encodeMode(options);
  assertCanonicalForEncoding("openai", messages);
  const items: UnknownRecord[] = [];

  for (const source of messages) {
    const textType = source.role === "assistant" ? "output_text" : "input_text";
    let messageContent: UnknownRecord[] = [];
    const flushMessage = (): void => {
      if (messageContent.length === 0) return;
      if (source.role === "tool") {
        throw new ProviderEncodingError(
          "openai",
          "text",
          "tool-role text is not a Responses message",
        );
      }
      items.push({
        type: "message",
        role: source.role,
        content: messageContent,
      });
      messageContent = [];
    };

    for (const block of source.content) {
      switch (block.type) {
        case "text": {
          const raw = rawMetadata(block);
          messageContent.push(
            raw !== null &&
              (raw.type === "output_text" || raw.type === "input_text")
              ? { ...raw, text: block.text }
              : { type: textType, text: block.text },
          );
          break;
        }
        case "tool_call": {
          if (source.role !== "assistant") {
            throw new ProviderEncodingError(
              "openai",
              block.type,
              "function calls require assistant role",
            );
          }
          flushMessage();
          const raw = rawMetadata(block);
          items.push(
            raw?.type === "function_call"
              ? {
                  ...raw,
                  call_id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                }
              : {
                  type: "function_call",
                  call_id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
          );
          break;
        }
        case "tool_result":
          flushMessage();
          items.push({
            type: "function_call_output",
            call_id: block.toolCallId,
            output: openAIResultOutput(block.content, mode),
          });
          break;
        case "reasoning": {
          const raw = rawMetadata(block);
          if (raw?.type !== "reasoning") {
            messageContent.push({
              type: textType,
              text: unencodableText(
                "openai",
                block,
                mode,
                "reasoning items must retain their original provider metadata",
              ),
            });
            break;
          }
          flushMessage();
          items.push(raw);
          break;
        }
        case "provider": {
          if (
            block.provider !== "openai" ||
            typeof block.raw !== "object" ||
            block.raw === null ||
            Array.isArray(block.raw)
          ) {
            messageContent.push({
              type: textType,
              text: unencodableText(
                "openai",
                block,
                mode,
                block.provider !== "openai"
                  ? "foreign provider block"
                  : "provider block has no inline raw object",
              ),
            });
            break;
          }
          if (block.placement === "content")
            messageContent.push(block.raw as UnknownRecord);
          else {
            flushMessage();
            items.push(block.raw as UnknownRecord);
          }
          break;
        }
        case "image": {
          const base64 = inlineBase64Of(block);
          if (
            base64 !== null &&
            (source.role === "user" || source.role === "system")
          ) {
            messageContent.push({
              type: "input_image",
              image_url: dataUrl(block.artifact.mediaType, base64),
            });
            break;
          }
          messageContent.push({
            type: textType,
            text: unencodableText(
              "openai",
              block,
              mode,
              base64 !== null
                ? `OpenAI accepts an image only in a user message, not a ${source.role} message; relay tool-produced images as a following user message`
                : "image artifacts require inlineArtifactBytes() or an application URL/base64 resolver",
            ),
          });
          break;
        }
        case "file":
          messageContent.push({
            type: textType,
            text: unencodableText(
              "openai",
              block,
              mode,
              "file artifacts require an application URL/base64 resolver",
            ),
          });
          break;
      }
    }
    flushMessage();
  }
  return items;
}

export interface AnthropicInput {
  system?: string;
  messages: UnknownRecord[];
}

/** Encodes canonical messages for Anthropic Messages API. */
export function toAnthropicInput(
  messages: CanonicalMessage[],
  options: ProviderEncodeOptions = {},
): AnthropicInput {
  const mode = encodeMode(options);
  assertCanonicalForEncoding("anthropic", messages);
  const systemParts: string[] = [];
  for (const source of messages.filter(
    (message) => message.role === "system",
  )) {
    for (const block of source.content) {
      systemParts.push(
        block.type === "text"
          ? block.text
          : unencodableText(
              "anthropic",
              block,
              mode,
              "system content must be text",
            ),
      );
    }
  }

  const encoded: Array<{ role: string; content: UnknownRecord[] }> = [];
  let previousRole: CanonicalMessage["role"] | undefined;
  for (const source of messages) {
    if (source.role === "system") continue;
    const content: UnknownRecord[] = [];
    for (const block of source.content) {
      switch (block.type) {
        case "text": {
          const raw = rawMetadata(block);
          content.push(
            raw?.type === "text"
              ? { ...raw, text: block.text }
              : { type: "text", text: block.text },
          );
          break;
        }
        case "tool_call": {
          if (source.role !== "assistant") {
            throw new ProviderEncodingError(
              "anthropic",
              block.type,
              "tool_use requires assistant role",
            );
          }
          const raw = rawMetadata(block);
          content.push(
            raw?.type === "tool_use"
              ? { ...raw, id: block.id, name: block.name, input: block.input }
              : {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                },
          );
          break;
        }
        case "tool_result": {
          if (source.role !== "tool" && source.role !== "user") {
            throw new ProviderEncodingError(
              "anthropic",
              block.type,
              "tool_result requires tool or user role",
            );
          }
          const result = anthropicResultContent(block.content, mode);
          content.push({
            type: "tool_result",
            tool_use_id: block.toolCallId,
            is_error: block.isError,
            ...(typeof result === "string" && result.length === 0
              ? {}
              : { content: result }),
          });
          break;
        }
        case "reasoning": {
          if (source.role !== "assistant") {
            throw new ProviderEncodingError(
              "anthropic",
              block.type,
              "thinking requires assistant role",
            );
          }
          const raw = rawMetadata(block);
          if (
            raw === null ||
            (raw.type !== "thinking" && raw.type !== "redacted_thinking")
          ) {
            content.push({
              type: "text",
              text: unencodableText(
                "anthropic",
                block,
                mode,
                "thinking blocks must retain their original provider metadata",
              ),
            });
            break;
          }
          content.push(raw);
          break;
        }
        case "provider":
          if (
            block.provider !== "anthropic" ||
            typeof block.raw !== "object" ||
            block.raw === null ||
            Array.isArray(block.raw)
          ) {
            content.push({
              type: "text",
              text: unencodableText(
                "anthropic",
                block,
                mode,
                block.provider !== "anthropic"
                  ? "foreign provider block"
                  : "provider block has no inline raw object",
              ),
            });
            break;
          }
          content.push(block.raw as UnknownRecord);
          break;
        case "image": {
          const image = anthropicImageBlock(block, mode);
          content.push(
            image ?? {
              type: "text",
              text: unencodableText(
                "anthropic",
                block,
                mode,
                "image artifacts need inlineArtifactBytes() or an application base64 resolver",
              ),
            },
          );
          break;
        }
        case "file":
          content.push({
            type: "text",
            text: unencodableText(
              "anthropic",
              block,
              mode,
              "file artifacts require an application base64 resolver",
            ),
          });
          break;
      }
    }
    if (content.length === 0) {
      throw new ProviderEncodingError(
        "anthropic",
        "message",
        "Anthropic messages cannot be empty",
      );
    }
    // All tool_result blocks answering one assistant turn belong in a single
    // Anthropic user message; splitting them suppresses parallel tool use.
    const previous = encoded[encoded.length - 1];
    if (source.role === "tool" && previousRole === "tool" && previous) {
      previous.content.push(...content);
    } else {
      encoded.push({
        role: source.role === "tool" ? "user" : source.role,
        content,
      });
    }
    previousRole = source.role;
  }

  return {
    ...(systemParts.length === 0 ? {} : { system: systemParts.join("\n") }),
    messages: encoded,
  };
}

/**
 * Encodes canonical messages for the OpenAI Chat Completions `messages`
 * shape, which OpenRouter and most OpenAI-compatible endpoints accept.
 * Unsupported blocks fail loudly unless the caller opts into explicit
 * `unencodable: "describe"` downgrades.
 */
export function toOpenAIChatInput(
  messages: CanonicalMessage[],
  options: ProviderEncodeOptions = {},
): UnknownRecord[] {
  const mode = encodeMode(options);
  assertCanonicalForEncoding("openai-chat", messages);
  const wire: UnknownRecord[] = [];

  for (const source of messages) {
    if (source.role === "tool") {
      // Chat Completions requires one tool message per tool_call_id.
      for (const block of source.content) {
        if (block.type !== "tool_result") {
          throw new ProviderEncodingError(
            "openai-chat",
            block.type,
            "tool messages must contain tool_result blocks",
          );
        }
        wire.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: openAIResultOutput(block.content, mode, "openai-chat"),
        });
      }
      continue;
    }

    if (source.role === "assistant") {
      const text: string[] = [];
      const toolCalls: UnknownRecord[] = [];
      for (const block of source.content) {
        switch (block.type) {
          case "text":
            text.push(block.text);
            break;
          case "tool_call":
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
            break;
          default:
            text.push(
              unencodableText(
                "openai-chat",
                block,
                mode,
                `chat completions assistant messages cannot carry ${block.type} blocks`,
              ),
            );
        }
      }
      wire.push({
        role: "assistant",
        content: text.length === 0 ? null : text.join("\n"),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      });
      continue;
    }

    // A user message with an inlined image becomes a content-part array
    // (text + image_url); otherwise system/user messages flatten to a string.
    const inlinableImage =
      source.role === "user" &&
      source.content.some(
        (block) => block.type === "image" && inlineBase64Of(block) !== null,
      );
    if (inlinableImage) {
      const parts = source.content.map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "image") {
          const base64 = inlineBase64Of(block);
          if (base64 !== null) {
            return {
              type: "image_url",
              image_url: { url: dataUrl(block.artifact.mediaType, base64) },
            };
          }
        }
        return {
          type: "text",
          text: unencodableText(
            "openai-chat",
            block,
            mode,
            `chat completions user messages cannot carry ${block.type} blocks`,
          ),
        };
      });
      wire.push({ role: "user", content: parts });
      continue;
    }

    const text = source.content.map((block) =>
      block.type === "text"
        ? block.text
        : unencodableText(
            "openai-chat",
            block,
            mode,
            block.type === "image"
              ? `chat completions cannot place an image in a ${source.role} message without inlineArtifactBytes(); relay tool-produced images as a user message`
              : `chat completions ${source.role} messages cannot carry ${block.type} blocks`,
          ),
    );
    wire.push({ role: source.role, content: text.join("\n") });
  }

  return wire;
}

/** Encodes tool definitions for Chat Completions / OpenRouter requests. */
export function toOpenAIChatTools(tools: ToolDefinition[]): UnknownRecord[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Parses a server-sent-event byte stream into its JSON `data:` payloads.
 * Comment lines and heartbeats are skipped; the OpenAI-style `[DONE]`
 * sentinel ends iteration. Works on a fetch response body or any byte
 * iterable, in any Web Streams runtime.
 */
export async function* sseJsonEvents(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";

  const dataOf = (eventText: string): string =>
    eventText
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

  async function* bytes(): AsyncGenerator<Uint8Array, void, undefined> {
    if (Symbol.asyncIterator in source) {
      yield* source as AsyncIterable<Uint8Array>;
      return;
    }
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value !== undefined) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  for await (const chunk of bytes()) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const data = dataOf(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (data.length === 0) continue;
      if (data === "[DONE]") return;
      yield JSON.parse(data) as unknown;
    }
  }
  const data = dataOf(buffer + decoder.decode());
  if (data.length > 0 && data !== "[DONE]") yield JSON.parse(data) as unknown;
}

export interface ChatCompletionStreamAccumulator {
  /** Feed one parsed chunk; returns the semantic deltas it contained. */
  push(chunk: unknown): ModelStreamEvent[];
  /**
   * The accumulated response in the non-streaming Chat Completions shape,
   * ready for fromOpenAIChatCompletion(); null before the first chunk.
   */
  response(): UnknownRecord | null;
}

interface StreamToolCallState {
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
  announced: boolean;
}

interface StreamChoiceState {
  finishReason: string | null;
  content: string | null;
  reasoning: string | null;
  toolCalls: Map<number, StreamToolCallState>;
  completed: boolean;
}

/**
 * Accumulates OpenAI-style Chat Completions stream chunks (as produced by
 * OpenRouter and compatible endpoints) into the complete response shape while
 * emitting canonical stream events for live projections. The journal should
 * record only the accumulated response, never individual deltas.
 */
export function createChatCompletionStreamAccumulator(): ChatCompletionStreamAccumulator {
  let envelope: UnknownRecord | null = null;
  let usage: unknown;
  const choices = new Map<number, StreamChoiceState>();

  const choiceState = (index: number): StreamChoiceState => {
    const existing = choices.get(index);
    if (existing !== undefined) return existing;
    const created: StreamChoiceState = {
      finishReason: null,
      content: null,
      reasoning: null,
      toolCalls: new Map(),
      completed: false,
    };
    choices.set(index, created);
    return created;
  };

  return {
    push(chunkValue) {
      const events: ModelStreamEvent[] = [];
      const chunk = record(chunkValue);
      envelope = envelope ?? {};
      for (const key of [
        "id",
        "model",
        "created",
        "provider",
        "system_fingerprint",
        "service_tier",
      ]) {
        if (chunk[key] !== undefined && envelope[key] === undefined) {
          envelope[key] = chunk[key];
        }
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = chunk.usage;
      }

      for (const choiceValue of list(chunk.choices)) {
        const choice = record(choiceValue);
        const index = Number.isSafeInteger(choice.index)
          ? (choice.index as number)
          : 0;
        const state = choiceState(index);
        const primary = index === 0;
        const delta = record(choice.delta);

        if (typeof delta.content === "string") {
          state.content = (state.content ?? "") + delta.content;
          if (primary && delta.content.length > 0) {
            events.push({ type: "text_delta", text: delta.content });
          }
        }
        const reasoningDelta =
          string(delta.reasoning_content) ?? string(delta.reasoning);
        if (reasoningDelta !== undefined) {
          state.reasoning = (state.reasoning ?? "") + reasoningDelta;
          if (primary && reasoningDelta.length > 0) {
            events.push({ type: "reasoning_delta", text: reasoningDelta });
          }
        }
        for (const callValue of list(delta.tool_calls)) {
          const call = record(callValue);
          const callIndex = Number.isSafeInteger(call.index)
            ? (call.index as number)
            : 0;
          const accumulated = state.toolCalls.get(callIndex) ?? {
            arguments: "",
            announced: false,
          };
          const fn = record(call.function);
          if (string(call.id) !== undefined) accumulated.id = call.id as string;
          if (string(call.type) !== undefined)
            accumulated.type = call.type as string;
          if (string(fn.name) !== undefined)
            accumulated.name = fn.name as string;
          if (
            !accumulated.announced &&
            accumulated.id !== undefined &&
            accumulated.name !== undefined
          ) {
            accumulated.announced = true;
            if (primary) {
              events.push({
                type: "tool_call_started",
                id: accumulated.id,
                name: accumulated.name,
              });
            }
          }
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            accumulated.arguments += fn.arguments;
            if (primary && accumulated.id !== undefined) {
              events.push({
                type: "tool_call_arguments_delta",
                id: accumulated.id,
                delta: fn.arguments,
              });
            }
          }
          state.toolCalls.set(callIndex, accumulated);
        }
        const finish = string(choice.finish_reason);
        if (finish !== undefined) {
          state.finishReason = finish;
          if (primary && !state.completed) {
            state.completed = true;
            events.push({ type: "stream_completed", finishReason: finish });
          }
        }
      }
      return events;
    },

    response() {
      if (envelope === null) return null;
      const encoded = [...choices.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, state]) => ({
          index,
          finish_reason: state.finishReason,
          message: {
            role: "assistant",
            content: state.content === "" ? null : state.content,
            ...(state.reasoning === null || state.reasoning.length === 0
              ? {}
              : { reasoning: state.reasoning }),
            ...(state.toolCalls.size === 0
              ? {}
              : {
                  tool_calls: [...state.toolCalls.entries()]
                    .sort((left, right) => left[0] - right[0])
                    .map(([callIndex, call]) => ({
                      index: callIndex,
                      ...(call.id === undefined ? {} : { id: call.id }),
                      type: call.type ?? "function",
                      function: {
                        ...(call.name === undefined ? {} : { name: call.name }),
                        arguments: call.arguments,
                      },
                    })),
                }),
          },
        }));
      return {
        ...envelope,
        object: "chat.completion",
        choices: encoded,
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
