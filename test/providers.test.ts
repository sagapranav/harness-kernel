import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatCompletionStreamAccumulator,
  fromAnthropicMessage,
  fromOpenAIChatCompletion,
  fromOpenAIResponse,
  inlineArtifactBytes,
  MemoryArtifactStore,
  nowIso,
  ProviderEncodingError,
  sseJsonEvents,
  toAnthropicInput,
  toOpenAIChatInput,
  toOpenAIChatTools,
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
  // OpenAI has no input concept for Anthropic thinking; it is dropped on the
  // wire (kept in the journal), and the rest of the message still encodes.
  const asOpenAI = toOpenAIInput([normalized.message]);
  assert.equal(
    asOpenAI.some((item) => item.type === "reasoning"),
    false,
  );
  assert.ok(asOpenAI.some((item) => item.type === "function_call"));
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

test("multi-tool-call transcripts round-trip through both encoders", () => {
  const messages = [
    {
      id: "user",
      role: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [{ type: "text" as const, text: "check both files" }],
    },
    {
      id: "assistant",
      role: "assistant" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
      content: [
        { type: "text" as const, text: "Reading both." },
        {
          type: "tool_call" as const,
          id: "call-1",
          name: "read",
          input: { path: "a.ts" },
        },
        {
          type: "tool_call" as const,
          id: "call-2",
          name: "read",
          input: { path: "b.ts" },
        },
      ],
    },
    {
      id: "tool-1",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:02.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "call-1",
          name: "read",
          isError: false,
          content: [{ type: "text" as const, text: "contents of a" }],
        },
      ],
    },
    {
      id: "tool-2",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:03.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "call-2",
          name: "read",
          isError: true,
          content: [{ type: "text" as const, text: "b is missing" }],
        },
      ],
    },
  ];

  const anthropic = toAnthropicInput(messages);
  assert.deepEqual(
    anthropic.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  const merged = anthropic.messages[2]?.content as Array<{
    type: string;
    tool_use_id: string;
    is_error: boolean;
  }>;
  assert.deepEqual(
    merged.map((block) => [block.type, block.tool_use_id, block.is_error]),
    [
      ["tool_result", "call-1", false],
      ["tool_result", "call-2", true],
    ],
  );

  const openai = toOpenAIInput(messages);
  assert.deepEqual(
    openai.map((item) => item.type),
    [
      "message",
      "message",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
    ],
  );
  assert.deepEqual(
    openai
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
    ["call-1", "call-2"],
  );
});

test("Anthropic encodes native tool-result images and rejects bare artifacts", () => {
  const artifact = {
    sha256: "0".repeat(64),
    uri: `sha256:${"0".repeat(64)}`,
    bytes: 4,
    mediaType: "image/png",
  };
  const nativeSource = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGk=" },
  };
  const toolMessage = (image: object) => [
    {
      id: "tool",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text" as const, text: "screenshot" }, image],
        },
      ],
    },
  ];

  const encoded = toAnthropicInput(
    toolMessage({
      type: "image",
      artifact,
      providerMetadata: { raw: nativeSource },
    }) as never,
  );
  const result = (
    encoded.messages[0]?.content as Array<{ content: unknown }>
  )[0];
  assert.deepEqual(result?.content, [
    { type: "text", text: "screenshot" },
    nativeSource,
  ]);

  assert.throws(
    () => toAnthropicInput(toolMessage({ type: "image", artifact }) as never),
    ProviderEncodingError,
  );
});

test("unencodable: describe downgrades blocks to deterministic placeholders", () => {
  const artifact = {
    sha256: "1".repeat(64),
    uri: `sha256:${"1".repeat(64)}`,
    bytes: 4,
    mediaType: "image/png",
  };
  const messages = [
    {
      id: "assistant",
      role: "assistant" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [
        {
          // Foreign-provider reasoning: replayable only to its origin.
          type: "reasoning" as const,
          text: "inspect",
          providerMetadata: { raw: { type: "thinking", thinking: "inspect" } },
        },
        { type: "text" as const, text: "done" },
      ],
    },
    {
      id: "tool",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:01.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "call-1",
          isError: false,
          content: [
            { type: "text" as const, text: "screenshot" },
            { type: "image" as const, artifact },
          ],
        },
      ],
    },
  ];

  // The image inside the tool result is the unencodable content here;
  // reasoning is dropped on the wire regardless of mode.
  assert.throws(() => toOpenAIInput(messages), ProviderEncodingError);
  const openai = toOpenAIInput(messages, { unencodable: "describe" });
  const assistant = openai[0]?.content as Array<{ type: string; text: string }>;
  assert.deepEqual(assistant[0], { type: "output_text", text: "done" });
  assert.equal(
    openai.some((item) => item.type === "reasoning"),
    false,
  );
  const output = openai.find((item) => item.type === "function_call_output");
  assert.equal(
    output?.output,
    `screenshot\n[unencodable image block: ${artifact.uri}]`,
  );

  // Reasoning without native Anthropic metadata degrades the same way.
  const bare = [
    {
      id: "assistant",
      role: "assistant" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [{ type: "reasoning" as const, text: "hidden" }],
    },
  ];
  assert.throws(() => toAnthropicInput(bare), ProviderEncodingError);
  const anthropic = toAnthropicInput(bare, { unencodable: "describe" });
  assert.deepEqual(anthropic.messages[0]?.content, [
    { type: "text", text: "[unencodable reasoning block]" },
  ]);

  assert.throws(
    () => toAnthropicInput(bare, { unencodable: "discard" as never }),
    TypeError,
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

test("Chat Completions outbound encoding links tools and results", () => {
  const wire = toOpenAIChatInput([
    {
      id: "msg-sys",
      role: "system",
      createdAt: nowIso(),
      content: [{ type: "text", text: "Be precise." }],
    },
    {
      id: "msg-user",
      role: "user",
      createdAt: nowIso(),
      content: [{ type: "text", text: "Add and check the clock." }],
    },
    {
      id: "msg-call",
      role: "assistant",
      createdAt: nowIso(),
      content: [
        { type: "tool_call", id: "call-1", name: "add", input: { a: 1, b: 2 } },
        { type: "tool_call", id: "call-2", name: "clock", input: {} },
      ],
    },
    {
      id: "msg-result-1",
      role: "tool",
      createdAt: nowIso(),
      content: [
        {
          type: "tool_result",
          toolCallId: "call-1",
          isError: false,
          content: [{ type: "text", text: "3" }],
        },
      ],
    },
    {
      id: "msg-result-2",
      role: "tool",
      createdAt: nowIso(),
      content: [
        {
          type: "tool_result",
          toolCallId: "call-2",
          isError: false,
          content: [{ type: "text", text: "12:00" }],
        },
      ],
    },
  ]);

  assert.deepEqual(
    wire.map((message) => message.role),
    ["system", "user", "assistant", "tool", "tool"],
  );
  const assistant = wire[2] as {
    content: unknown;
    tool_calls: Array<{ id: string; function: { arguments: string } }>;
  };
  assert.equal(assistant.content, null);
  assert.deepEqual(
    assistant.tool_calls.map((call) => call.id),
    ["call-1", "call-2"],
  );
  assert.deepEqual(JSON.parse(assistant.tool_calls[0]!.function.arguments), {
    a: 1,
    b: 2,
  });
  assert.deepEqual(wire[3], {
    role: "tool",
    tool_call_id: "call-1",
    content: "3",
  });

  const tools = toOpenAIChatTools([
    {
      name: "add",
      description: "Add numbers.",
      inputSchema: { type: "object" },
    },
  ]);
  assert.deepEqual(tools, [
    {
      type: "function",
      function: {
        name: "add",
        description: "Add numbers.",
        parameters: { type: "object" },
      },
    },
  ]);

  // Reasoning is output-only for Chat Completions: dropped on the wire.
  const reasoningOnly = toOpenAIChatInput([
    {
      id: "msg-reasoning",
      role: "assistant",
      createdAt: nowIso(),
      content: [{ type: "reasoning", text: "hidden" }],
    },
  ]);
  assert.equal(reasoningOnly[0]!.content, null);
  assert.equal(JSON.stringify(reasoningOnly).includes("hidden"), false);
});

test("chat completion streams accumulate into a normalizable response", async () => {
  // Modeled on a captured OpenRouter SSE stream: a comment heartbeat, a tool
  // call split across chunks, empty-content finish chunks, and a usage chunk.
  const sse = [
    ": OPENROUTER PROCESSING",
    "",
    'data: {"id":"gen-1","model":"openai/gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call-9","type":"function","function":{"name":"add","arguments":""}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1,"}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b\\":2}"}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}]}',
    "",
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.001}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(sse);
  async function* jaggedChunks(): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < bytes.length; index += 7) {
      yield bytes.subarray(index, index + 7);
    }
  }

  const accumulator = createChatCompletionStreamAccumulator();
  const events: string[] = [];
  for await (const chunk of sseJsonEvents(jaggedChunks())) {
    for (const event of accumulator.push(chunk)) events.push(event.type);
  }
  assert.deepEqual(events, [
    "tool_call_started",
    "tool_call_arguments_delta",
    "tool_call_arguments_delta",
    "stream_completed",
  ]);

  const normalized = fromOpenAIChatCompletion(accumulator.response(), {
    model: "openai/gpt-4o-mini",
  });
  // The empty streamed content must not become an empty text block.
  assert.deepEqual(
    normalized.message.content.map((block) => block.type),
    ["tool_call"],
  );
  const call = normalized.message.content[0]!;
  assert.deepEqual(call.type === "tool_call" ? call.input : null, {
    a: 1,
    b: 2,
  });
  assert.equal(normalized.telemetry.stopReason, "tool_use");
  assert.equal(normalized.telemetry.usage.inputTokens, 10);
  assert.equal(normalized.telemetry.costUsd, 0.001);
});

test("chat completion streams accumulate text and reasoning deltas", async () => {
  const accumulator = createChatCompletionStreamAccumulator();
  const collected: Array<{ type: string; text?: string }> = [];
  for (const chunk of [
    {
      id: "gen-2",
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", reasoning: "thin" } }],
    },
    { id: "gen-2", choices: [{ index: 0, delta: { reasoning: "king" } }] },
    { id: "gen-2", choices: [{ index: 0, delta: { content: "Hel" } }] },
    { id: "gen-2", choices: [{ index: 0, delta: { content: "lo" } }] },
    {
      id: "gen-2",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  ]) {
    collected.push(...accumulator.push(chunk));
  }
  assert.deepEqual(collected, [
    { type: "reasoning_delta", text: "thin" },
    { type: "reasoning_delta", text: "king" },
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
    { type: "stream_completed", finishReason: "stop" },
  ]);

  const normalized = fromOpenAIChatCompletion(accumulator.response(), {
    model: "m",
  });
  assert.deepEqual(
    normalized.message.content.map((block) => block.type),
    ["text", "reasoning"],
  );
  const text = normalized.message.content[0]!;
  assert.equal(text.type === "text" ? text.text : null, "Hello");
  const reasoning = normalized.message.content[1]!;
  assert.equal(
    reasoning.type === "reasoning" ? reasoning.text : null,
    "thinking",
  );
  assert.equal(normalized.telemetry.stopReason, "end");
});

test("inlineArtifactBytes passes tool-produced images back to the model", async () => {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const artifacts = new MemoryArtifactStore();
  const ref = await artifacts.put(png, { mediaType: "image/png" });

  // A journaled tool result carrying only an artifact reference (as the loop
  // produces it) cannot be encoded until the bytes are resolved.
  const toolMessages = [
    {
      id: "t",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [
        {
          type: "tool_result" as const,
          toolCallId: "shot-1",
          isError: false,
          content: [{ type: "image" as const, artifact: ref }],
        },
      ],
    },
  ];
  assert.throws(() => toAnthropicInput(toolMessages), ProviderEncodingError);

  // Anthropic accepts the image inside the tool result once inlined.
  const resolved = await inlineArtifactBytes(toolMessages, artifacts);
  const anthropic = toAnthropicInput(resolved);
  const toolResult = anthropic.messages
    .flatMap((message) => message.content as Array<Record<string, unknown>>)
    .find((block) => block.type === "tool_result");
  const image = (toolResult!.content as Array<Record<string, unknown>>)[0]!;
  assert.equal(image.type, "image");
  assert.deepEqual(image.source, {
    type: "base64",
    media_type: "image/png",
    data: btoa(String.fromCharCode(...png)),
  });

  // OpenAI cannot place an image in a tool result; it must be relayed as a
  // user message, where inlining produces a data-url image part.
  const relayed = await inlineArtifactBytes(
    [
      {
        id: "u",
        role: "user" as const,
        createdAt: "2026-01-01T00:00:01.000Z",
        content: [
          { type: "text" as const, text: "Here is the screenshot:" },
          { type: "image" as const, artifact: ref },
        ],
      },
    ],
    artifacts,
  );
  const chat = toOpenAIChatInput(relayed);
  const parts = chat[0]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "image_url"],
  );
  assert.match(
    (parts[1]!.image_url as { url: string }).url,
    /^data:image\/png;base64,/,
  );
  const responses = toOpenAIInput(relayed);
  const item = responses.find(
    (entry) =>
      entry.type === "message" &&
      Array.isArray(entry.content) &&
      (entry.content as Array<Record<string, unknown>>).some(
        (part) => part.type === "input_image",
      ),
  );
  assert.ok(item);

  // An image left in an OpenAI tool result still fails loudly with guidance.
  assert.throws(
    () => toOpenAIChatInput(resolved),
    /relay tool-produced images as a user message/,
  );
});

test("imageDetail sets OpenAI image fidelity and omits by default", async () => {
  const artifacts = new MemoryArtifactStore();
  const ref = await artifacts.put(new Uint8Array([1, 2, 3]), {
    mediaType: "image/png",
  });
  const messages = await inlineArtifactBytes(
    [
      {
        id: "u",
        role: "user" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        content: [
          { type: "text" as const, text: "look" },
          { type: "image" as const, artifact: ref },
        ],
      },
    ],
    artifacts,
  );

  const defaultChat = toOpenAIChatInput(messages);
  const defaultPart = (
    defaultChat[0]!.content as Array<Record<string, unknown>>
  ).find((part) => part.type === "image_url");
  assert.equal(
    (defaultPart!.image_url as Record<string, unknown>).detail,
    undefined,
  );

  const lowChat = toOpenAIChatInput(messages, { imageDetail: "low" });
  const lowPart = (lowChat[0]!.content as Array<Record<string, unknown>>).find(
    (part) => part.type === "image_url",
  );
  assert.equal((lowPart!.image_url as Record<string, unknown>).detail, "low");

  const responses = toOpenAIInput(messages, { imageDetail: "high" });
  const imageItem = (
    responses.find((item) => item.type === "message")!.content as Array<
      Record<string, unknown>
    >
  ).find((part) => part.type === "input_image");
  assert.equal(imageItem!.detail, "high");

  assert.throws(
    () => toOpenAIChatInput(messages, { imageDetail: "medium" as never }),
    /imageDetail/,
  );
});

test("reasoning blocks are dropped on the wire, not rejected", async () => {
  // A reasoning model (e.g. GLM) returns reasoning in assistant messages. It is
  // output-only for these APIs, so encoders omit it rather than throwing.
  const message = {
    id: "a",
    role: "assistant" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    content: [
      { type: "reasoning" as const, text: "Let me think about the plan." },
      { type: "text" as const, text: "Writing the file." },
      {
        type: "tool_call" as const,
        id: "call-1",
        name: "write_file",
        input: { path: "a.js" },
      },
    ],
  };

  const chat = toOpenAIChatInput([message]);
  assert.equal(chat.length, 1);
  assert.equal(chat[0]!.content, "Writing the file.");
  assert.equal((chat[0]!.tool_calls as Array<{ id: string }>)[0]!.id, "call-1");
  assert.equal(JSON.stringify(chat).includes("think about the plan"), false);

  const responses = toOpenAIInput([message]);
  assert.equal(
    JSON.stringify(responses).includes("think about the plan"),
    false,
  );
  assert.ok(responses.some((item) => item.type === "function_call"));
});
