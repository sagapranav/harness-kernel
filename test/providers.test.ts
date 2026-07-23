import assert from "node:assert/strict";
import test from "node:test";
import {
  fromAnthropicMessage,
  fromOpenAIChatCompletion,
  fromOpenAIResponse,
  nowIso,
  ProviderEncodingError,
  toAnthropicInput,
  toOpenAIInput,
} from "../src/index.js";

test("OpenAI Responses normalization retains tools, usage, and unknown blocks", () => {
  const normalized = fromOpenAIResponse(
    {
      id: "resp_1",
      model: "served-model",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "hello" },
            { type: "future_block", payload: 1 },
          ],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"query":"logs"}',
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 10 },
      },
    },
    { model: "requested-model", latencyMs: 50 },
  );

  assert.equal(normalized.message.id, "resp_1");
  assert.equal(normalized.telemetry.servedModel, "served-model");
  assert.equal(normalized.telemetry.usage.cacheReadTokens, 10);
  assert.equal(
    normalized.message.content.some((block) => block.type === "provider"),
    true,
  );
  const call = normalized.message.content.find(
    (block) => block.type === "tool_call",
  );
  assert.equal(call?.type, "tool_call");
  if (call?.type === "tool_call") {
    assert.equal(call.id, "call_1");
    assert.equal(call.name, "search");
    assert.deepEqual(call.input, { query: "logs" });
  }
  assert.equal(normalized.providerSnapshot?.provider, "openai");
});

test("OpenAI Chat Completions normalization supports compatible endpoints", () => {
  const normalized = fromOpenAIChatCompletion(
    {
      id: "chat_1",
      model: "compat-model",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_2",
                function: { name: "lookup", arguments: '{"id":2}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    { model: "compat-model" },
  );
  assert.equal(normalized.telemetry.stopReason, "tool_use");
  assert.equal(normalized.message.content[0]?.type, "tool_call");
});

test("Anthropic normalization and outbound encoders preserve shared semantics", () => {
  const normalized = fromAnthropicMessage(
    {
      id: "msg_1",
      model: "served-claude",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "inspect", signature: "sig" },
        { type: "text", text: "I will inspect." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "read",
          input: { path: "a.ts" },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        output_tokens_details: { thinking_tokens: 12 },
      },
    },
    { model: "requested-claude" },
  );

  assert.equal(normalized.telemetry.stopReason, "tool_use");
  assert.equal(normalized.telemetry.usage.cacheReadTokens, 80);
  assert.equal(normalized.telemetry.usage.cacheWriteTokens, 10);
  assert.equal(normalized.telemetry.usage.reasoningTokens, 12);
  const encoded = toAnthropicInput([normalized.message]);
  assert.equal(encoded.messages[0]?.role, "assistant");
  assert.equal(
    (encoded.messages[0]?.content as Array<{ type: string }>).some(
      (block) => block.type === "tool_use",
    ),
    true,
  );
  assert.throws(
    () => toOpenAIInput([normalized.message]),
    ProviderEncodingError,
  );
});

test("OpenAI Responses encoding preserves item order and fails on unsupported artifacts", () => {
  const messages = [
    {
      id: "assistant",
      role: "assistant" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [
        { type: "text" as const, text: "before" },
        {
          type: "tool_call" as const,
          id: "call-1",
          name: "lookup",
          input: { id: 1 },
        },
      ],
    },
    {
      id: "tool",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text" as const, text: "result" }],
        },
      ],
    },
  ];
  assert.deepEqual(
    toOpenAIInput(messages).map((item) => item.type),
    ["message", "function_call", "function_call_output"],
  );

  assert.throws(
    () =>
      toOpenAIInput([
        {
          id: "image",
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          content: [
            {
              type: "image",
              artifact: {
                sha256: "0".repeat(64),
                uri: `sha256:${"0".repeat(64)}`,
                bytes: 1,
                mediaType: "image/png",
              },
            },
          ],
        },
      ]),
    /resolver/,
  );
});

test("provider normalization exposes malformed tool arguments and ambiguous stops", () => {
  const malformed = fromOpenAIResponse(
    {
      id: "resp-malformed",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "bad-call",
          name: "lookup",
          arguments: "{",
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        input_tokens_details: { cache_write_tokens: 1 },
      },
    },
    { model: "test" },
  );
  const call = malformed.message.content[0];
  assert.equal(call?.type, "tool_call");
  if (call?.type === "tool_call")
    assert.equal(typeof call.inputParseError, "string");
  assert.equal(malformed.telemetry.usage.cacheWriteTokens, 1);

  const paused = fromAnthropicMessage(
    {
      id: "paused",
      stop_reason: "pause_turn",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
    { model: "test" },
  );
  assert.equal(paused.telemetry.stopReason, "pause");
});

test("provider normalization rejects non-durable inputs and sanitizes token counts", () => {
  assert.throws(
    () => fromOpenAIResponse(undefined, { model: "test" }),
    /provider response/,
  );
  assert.throws(
    () =>
      fromAnthropicMessage(
        { content: [], usage: {} },
        { model: "", latencyMs: -1 },
      ),
    /model must be a non-empty string/,
  );
  const normalized = fromOpenAIChatCompletion(
    {
      id: "invalid-usage",
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: -1, completion_tokens: 1.5 },
    },
    { model: "test" },
  );
  assert.deepEqual(normalized.telemetry.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  assert.throws(
    () =>
      toOpenAIInput([
        {
          id: "malformed",
          role: "user",
          createdAt: nowIso(),
          content: [null] as never,
        },
      ]),
    ProviderEncodingError,
  );
});
