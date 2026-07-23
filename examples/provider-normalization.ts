// Run with:
//   npm install && npm run build && node dist/examples/provider-normalization.js
//
// Normalizes realistic provider response payloads into canonical messages,
// then re-encodes a mixed transcript for each provider. In a real harness the
// payloads come from the OpenAI/Anthropic SDKs inside a ModelInvoker.
import {
  fromAnthropicMessage,
  fromOpenAIResponse,
  toAnthropicInput,
  toOpenAIInput,
  type CanonicalMessage,
} from "@sagapranav/harness-kernel";

// An OpenAI Responses payload with text, a tool call, and a block this
// library version does not know. Nothing is silently discarded: the unknown
// block is retained as a `provider` block and the exact payload is kept as a
// provider snapshot.
const openai = fromOpenAIResponse(
  {
    id: "resp_1",
    model: "served-model",
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "Checking the logs." },
          { type: "future_block", payload: { novel: true } },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "search",
        arguments: '{"query":"errors since deploy"}',
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
console.log("openai canonical blocks:", [
  ...openai.message.content.map((block) => block.type),
]);
console.log("openai telemetry:", openai.telemetry);

// An Anthropic Messages payload with thinking, text, and a tool call.
const anthropic = fromAnthropicMessage(
  {
    id: "msg_1",
    model: "served-claude",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "inspect the portal", signature: "sig" },
      { type: "text", text: "I will inspect the portal." },
      { type: "tool_use", id: "tool_1", name: "read", input: { path: "a.ts" } },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
  { model: "requested-claude" },
);
console.log("anthropic canonical blocks:", [
  ...anthropic.message.content.map((block) => block.type),
]);

// A canonical transcript is provider-neutral: the same messages encode for
// either provider. Tool-role messages produced by the loop merge into one
// Anthropic user message so parallel tool use is preserved.
const transcript: CanonicalMessage[] = [
  {
    id: "msg-user",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: [{ type: "text", text: "What broke?" }],
  },
  anthropic.message,
  {
    id: "msg-result",
    role: "tool",
    createdAt: "2026-01-01T00:00:01.000Z",
    content: [
      {
        type: "tool_result",
        toolCallId: "tool_1",
        name: "read",
        isError: false,
        content: [{ type: "text", text: "export const broken = true;" }],
      },
    ],
  },
];
console.log(
  "anthropic wire messages:",
  toAnthropicInput(transcript).messages.map((message) => message.role),
);
// Encoders never silently drop content. The Anthropic thinking block has no
// native OpenAI form, so the default throws; `unencodable: "describe"`
// replaces it with an explicit text placeholder instead.
console.log(
  "openai wire items:",
  toOpenAIInput(transcript, { unencodable: "describe" }).map(
    (item) => (item as { type?: string }).type ?? "message",
  ),
);
