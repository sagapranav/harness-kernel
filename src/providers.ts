import { createId, nowIso } from './ids.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelStopReason,
  NormalizedModelResponse,
  TokenUsage,
} from './protocol.js';

type UnknownRecord = Record<string, unknown>;

export interface NormalizeProviderOptions {
  model: string;
  latencyMs?: number;
  requestId?: string;
  preserveUnknownBlocks?: boolean;
}

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _raw: value, _parseError: true };
  }
}

function stopReason(value: unknown): ModelStopReason {
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'completed':
      return 'end';
    case 'tool_calls':
    case 'tool_use':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
    case 'incomplete':
      return 'length';
    case 'content_filter':
    case 'refusal':
      return 'content_filter';
    case 'cancelled':
      return 'aborted';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

function message(
  provider: string,
  content: ContentBlock[],
  id?: string,
): CanonicalMessage {
  return {
    id: id ?? createId('msg'),
    role: 'assistant',
    content,
    createdAt: nowIso(),
    provider,
  };
}

function unknownBlock(
  provider: string,
  raw: unknown,
  preserve: boolean,
): ContentBlock[] {
  if (!preserve) return [];
  return [
    {
      type: 'provider',
      provider,
      providerType: string(record(raw).type) ?? 'unknown',
      raw,
    },
  ];
}

/** Normalizes an OpenAI Responses API response without depending on its SDK. */
export function fromOpenAIResponse(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  const root = record(raw);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;

  for (const itemValue of list(root.output)) {
    const item = record(itemValue);
    switch (item.type) {
      case 'message':
        for (const partValue of list(item.content)) {
          const part = record(partValue);
          if (part.type === 'output_text' && typeof part.text === 'string') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
            content.push({ type: 'text', text: part.refusal });
          } else {
            content.push(...unknownBlock('openai', partValue, preserve));
          }
        }
        break;
      case 'function_call':
        content.push({
          type: 'tool_call',
          id: string(item.call_id) ?? string(item.id) ?? createId('call'),
          name: string(item.name) ?? 'unknown_tool',
          input: parseArguments(item.arguments),
        });
        break;
      case 'reasoning': {
        const summary = list(item.summary)
          .map((part) => string(record(part).text))
          .filter((part): part is string => part !== undefined)
          .join('\n');
        content.push({
          type: 'reasoning',
          ...(summary.length === 0 ? { redacted: true } : { text: summary }),
        });
        break;
      }
      default:
        content.push(...unknownBlock('openai', itemValue, preserve));
    }
  }

  const usage = record(root.usage);
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  const normalizedStopReason: ModelStopReason = content.some((block) => block.type === 'tool_call')
    ? 'tool_use'
    : stopReason(root.status);
  return {
    message: message('openai', content, string(root.id)),
    telemetry: {
      provider: 'openai',
      model: options.model,
      servedModel: string(root.model),
      latencyMs: options.latencyMs ?? 0,
      requestId: options.requestId ?? string(root.id),
      stopReason: normalizedStopReason,
      usage: {
        inputTokens: number(usage.input_tokens),
        outputTokens: number(usage.output_tokens),
        cacheReadTokens: number(inputDetails.cached_tokens),
        reasoningTokens: number(outputDetails.reasoning_tokens),
      },
    },
  };
}

/** Normalizes the older OpenAI-compatible Chat Completions response shape. */
export function fromOpenAIChatCompletion(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  const root = record(raw);
  const choice = record(list(root.choices)[0]);
  const source = record(choice.message);
  const content: ContentBlock[] = [];

  if (typeof source.content === 'string') content.push({ type: 'text', text: source.content });
  for (const callValue of list(source.tool_calls)) {
    const call = record(callValue);
    const fn = record(call.function);
    content.push({
      type: 'tool_call',
      id: string(call.id) ?? createId('call'),
      name: string(fn.name) ?? 'unknown_tool',
      input: parseArguments(fn.arguments),
    });
  }
  if (typeof source.reasoning_content === 'string') {
    content.push({ type: 'reasoning', text: source.reasoning_content });
  }

  const usage = record(root.usage);
  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  return {
    message: message('openai', content, string(root.id)),
    telemetry: {
      provider: 'openai',
      model: options.model,
      servedModel: string(root.model),
      latencyMs: options.latencyMs ?? 0,
      requestId: options.requestId ?? string(root.id),
      stopReason: stopReason(choice.finish_reason),
      usage: {
        inputTokens: number(usage.prompt_tokens),
        outputTokens: number(usage.completion_tokens),
        cacheReadTokens: number(promptDetails.cached_tokens),
        reasoningTokens: number(completionDetails.reasoning_tokens),
      },
    },
  };
}

/** Normalizes an Anthropic Messages API response without depending on its SDK. */
export function fromAnthropicMessage(
  raw: unknown,
  options: NormalizeProviderOptions,
): NormalizedModelResponse {
  const root = record(raw);
  const content: ContentBlock[] = [];
  const preserve = options.preserveUnknownBlocks ?? true;

  for (const blockValue of list(root.content)) {
    const block = record(blockValue);
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: string(block.text) ?? '' });
        break;
      case 'tool_use':
        content.push({
          type: 'tool_call',
          id: string(block.id) ?? createId('call'),
          name: string(block.name) ?? 'unknown_tool',
          input: block.input ?? {},
        });
        break;
      case 'thinking':
        content.push({
          type: 'reasoning',
          text: string(block.thinking),
          signature: string(block.signature),
        });
        break;
      case 'redacted_thinking':
        content.push({ type: 'reasoning', redacted: true });
        break;
      default:
        content.push(...unknownBlock('anthropic', blockValue, preserve));
    }
  }

  const usage = record(root.usage);
  const cacheRead = number(usage.cache_read_input_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  const normalizedUsage: TokenUsage = {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
  };
  return {
    message: message('anthropic', content, string(root.id)),
    telemetry: {
      provider: 'anthropic',
      model: options.model,
      servedModel: string(root.model),
      latencyMs: options.latencyMs ?? 0,
      requestId: options.requestId ?? string(root.id),
      stopReason: stopReason(root.stop_reason),
      usage: normalizedUsage,
    },
  };
}

/**
 * Encodes canonical messages for OpenAI Responses API `input`. Unsupported
 * canonical blocks stay explicit instead of being silently dropped.
 */
export function toOpenAIInput(messages: CanonicalMessage[]): UnknownRecord[] {
  return messages.flatMap((source): UnknownRecord[] => {
    const regular: UnknownRecord[] = [];
    const content: UnknownRecord[] = [];
    for (const block of source.content) {
      if (block.type === 'text') {
        content.push({
          type: source.role === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        });
      } else if (block.type === 'tool_call') {
        regular.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        regular.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: block.content
            .filter((part) => part.type === 'text')
            .map((part) => (part as { type: 'text'; text: string }).text)
            .join('\n'),
        });
      }
    }
    if (content.length > 0) regular.unshift({ type: 'message', role: source.role, content });
    return regular;
  });
}

export interface AnthropicInput {
  system?: string;
  messages: UnknownRecord[];
}

/** Encodes canonical messages for Anthropic Messages API. */
export function toAnthropicInput(messages: CanonicalMessage[]): AnthropicInput {
  const system = messages
    .filter((source) => source.role === 'system')
    .flatMap((source) => source.content)
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');

  const encoded = messages
    .filter((source) => source.role !== 'system')
    .map((source) => {
      const content: UnknownRecord[] = source.content.flatMap((block): UnknownRecord[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_call') {
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
        }
        if (block.type === 'tool_result') {
          return [
            {
              type: 'tool_result',
              tool_use_id: block.toolCallId,
              is_error: block.isError,
              content: block.content
                .filter((part) => part.type === 'text')
                .map((part) => (part as { type: 'text'; text: string }).text)
                .join('\n'),
            },
          ];
        }
        return [];
      });
      return { role: source.role === 'tool' ? 'user' : source.role, content };
    });

  return { ...(system.length === 0 ? {} : { system }), messages: encoded };
}
