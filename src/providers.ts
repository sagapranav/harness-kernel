import { assertArtifactRef } from "./artifacts.js";
import { createId, nowIso } from "./ids.js";
import { assertJsonSerializable } from "./json.js";
import type {
  ArtifactRef,
  CanonicalMessage,
  ContentBlock,
  Metadata,
  ModelStopReason,
  NormalizedModelResponse,
  ProviderBlock,
  TokenUsage,
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
}

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
  id?: string,
): CanonicalMessage {
  return {
    id: id ?? createId("msg"),
    role: "assistant",
    content,
    createdAt: nowIso(),
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
              id: string(item.call_id) ?? string(item.id) ?? createId("call"),
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
    message: message("openai", content, canonicalMessageId ?? string(root.id)),
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
  const root = record(raw);
  const choice = record(list(root.choices)[0]);
  const source = record(choice.message);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;
  let refused = false;

  if (typeof source.content === "string") {
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
          id: string(call.id) ?? createId("call"),
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
  if (typeof source.reasoning_content === "string") {
    content.push({
      type: "reasoning",
      text: source.reasoning_content,
      providerMetadata: { raw: source.reasoning_content },
    });
  }

  const usage = record(root.usage);
  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  const response: NormalizedModelResponse = {
    message: message(
      "openai-chat",
      content,
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
              id: string(block.id) ?? createId("call"),
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
    message: message("anthropic", content, string(root.id)),
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

function textOnlyResult(provider: string, blocks: ContentBlock[]): string {
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      (block) =>
        typeof block !== "object" ||
        block === null ||
        block.type !== "text" ||
        typeof block.text !== "string",
    )
  ) {
    throw new ProviderEncodingError(
      provider,
      "tool_result",
      `${provider} tool-result encoding requires text-only content or an application resolver`,
    );
  }
  return blocks
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");
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
 * blocks fail loudly so provider input is never silently weakened.
 */
export function toOpenAIInput(messages: CanonicalMessage[]): UnknownRecord[] {
  assertCanonicalForEncoding("openai", messages);
  const items: UnknownRecord[] = [];

  for (const source of messages) {
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
          const expectedType =
            source.role === "assistant" ? "output_text" : "input_text";
          messageContent.push(
            raw !== null &&
              (raw.type === "output_text" || raw.type === "input_text")
              ? { ...raw, text: block.text }
              : { type: expectedType, text: block.text },
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
            output: textOnlyResult("openai", block.content),
          });
          break;
        case "reasoning": {
          flushMessage();
          const raw = rawMetadata(block);
          if (raw?.type !== "reasoning") {
            throw new ProviderEncodingError(
              "openai",
              block.type,
              "reasoning items must retain their original provider metadata",
            );
          }
          items.push(raw);
          break;
        }
        case "provider":
          if (block.provider !== "openai") {
            throw new ProviderEncodingError(
              "openai",
              block.type,
              "foreign provider block",
            );
          }
          if (
            typeof block.raw !== "object" ||
            block.raw === null ||
            Array.isArray(block.raw)
          ) {
            throw new ProviderEncodingError(
              "openai",
              block.type,
              "provider block has no inline raw object",
            );
          }
          if (block.placement === "content")
            messageContent.push(block.raw as UnknownRecord);
          else {
            flushMessage();
            items.push(block.raw as UnknownRecord);
          }
          break;
        case "image":
        case "file":
          throw new ProviderEncodingError(
            "openai",
            block.type,
            `${block.type} artifacts require an application URL/base64 resolver`,
          );
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
export function toAnthropicInput(messages: CanonicalMessage[]): AnthropicInput {
  assertCanonicalForEncoding("anthropic", messages);
  const systemParts: string[] = [];
  for (const source of messages.filter(
    (message) => message.role === "system",
  )) {
    for (const block of source.content) {
      if (block.type !== "text") {
        throw new ProviderEncodingError(
          "anthropic",
          block.type,
          "system content must be text",
        );
      }
      systemParts.push(block.text);
    }
  }

  const encoded = messages
    .filter((source) => source.role !== "system")
    .map((source) => {
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
            const resultText = textOnlyResult("anthropic", block.content);
            content.push({
              type: "tool_result",
              tool_use_id: block.toolCallId,
              is_error: block.isError,
              ...(resultText.length === 0 ? {} : { content: resultText }),
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
              throw new ProviderEncodingError(
                "anthropic",
                block.type,
                "thinking blocks must retain their original provider metadata",
              );
            }
            content.push(raw);
            break;
          }
          case "provider":
            if (block.provider !== "anthropic") {
              throw new ProviderEncodingError(
                "anthropic",
                block.type,
                "foreign provider block",
              );
            }
            if (
              typeof block.raw !== "object" ||
              block.raw === null ||
              Array.isArray(block.raw)
            ) {
              throw new ProviderEncodingError(
                "anthropic",
                block.type,
                "provider block has no inline raw object",
              );
            }
            content.push(block.raw as UnknownRecord);
            break;
          case "image":
          case "file":
            throw new ProviderEncodingError(
              "anthropic",
              block.type,
              `${block.type} artifacts require an application base64 resolver`,
            );
        }
      }
      if (content.length === 0) {
        throw new ProviderEncodingError(
          "anthropic",
          "message",
          "Anthropic messages cannot be empty",
        );
      }
      return { role: source.role === "tool" ? "user" : source.role, content };
    });

  return {
    ...(systemParts.length === 0 ? {} : { system: systemParts.join("\n") }),
    messages: encoded,
  };
}
