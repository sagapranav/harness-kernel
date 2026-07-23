// Run with:
//   npm install && npm run build
//   OPENROUTER_API_KEY=... node dist/examples/openrouter-streaming.js
// (or `node --env-file=.env dist/examples/openrouter-streaming.js`)
//
// A real streaming agent over OpenRouter's OpenAI-compatible Chat
// Completions endpoint: canonical context encodes with toOpenAIChatInput(),
// SSE chunks stream through sseJsonEvents() into an accumulator that emits
// live ModelStreamEvents, and the loop journals only the complete
// normalized response — streaming is a live projection, not durable state.
import {
  MemoryJournalStore,
  MemorySessionCatalog,
  SessionManager,
  createChatCompletionStreamAccumulator,
  createId,
  fromOpenAIChatCompletion,
  messageEvent,
  nowIso,
  runAgentLoop,
  sseJsonEvents,
  toOpenAIChatInput,
  toOpenAIChatTools,
  type ActionExecutor,
  type ImmutableRunConfig,
  type ModelInvoker,
} from "@sagapranav/harness-kernel";

const key = process.env.OPENROUTER_API_KEY;
if (key === undefined || key.length === 0) {
  console.log("OPENROUTER_API_KEY is not set; skipping the live example.");
  process.exit(0);
}

const config: ImmutableRunConfig = {
  id: "openrouter-streaming-v1",
  version: 1,
  createdAt: nowIso(),
  provider: {
    provider: "openai-chat",
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
  },
  systemPrompt: "You are a precise assistant. Use tools when asked.",
  tools: [
    {
      name: "add_numbers",
      description: "Add two numbers and return the sum.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ],
};

const model: ModelInvoker = {
  async invoke(request, signal) {
    const started = Date.now();
    const response = await fetch(config.provider.endpoint!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({
        model: config.provider.model,
        messages: [
          { role: "system", content: config.systemPrompt },
          ...toOpenAIChatInput(request.context.messages),
        ],
        tools: toOpenAIChatTools(config.tools),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok || response.body === null) {
      throw new Error(
        `openrouter ${response.status}: ${await response.text()}`,
      );
    }
    const accumulator = createChatCompletionStreamAccumulator();
    for await (const chunk of sseJsonEvents(response.body)) {
      for (const event of accumulator.push(chunk)) request.onStream?.(event);
    }
    return fromOpenAIChatCompletion(accumulator.response(), {
      model: config.provider.model,
      latencyMs: Date.now() - started,
    });
  },
};

const actions: ActionExecutor = {
  async execute(invocation) {
    const input = invocation.call.input as { a?: unknown; b?: unknown };
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [
        { type: "text", text: String(Number(input.a) + Number(input.b)) },
      ],
    };
  },
};

const journal = new MemoryJournalStore();
const sessions = new SessionManager(journal, new MemorySessionCatalog());
const session = await sessions.create(config, {
  purpose: "Streaming OpenRouter demo",
});
await journal.append(
  session.id,
  messageEvent({
    id: createId("msg"),
    role: "user",
    createdAt: nowIso(),
    content: [
      {
        type: "text",
        text: "What is 12345 plus 67890? Use add_numbers, then answer in one sentence.",
      },
    ],
  }),
);

const outcome = await runAgentLoop({
  sessionId: session.id,
  config,
  journal,
  model,
  actions,
  modelRetryDelayMs: (_error, attempt) => (attempt <= 2 ? 500 * attempt : null),
  onModelStream: (event) => {
    if (event.type === "text_delta") process.stdout.write(event.text);
    else if (event.type === "tool_call_started")
      console.log(`\n[tool call: ${event.name}]`);
  },
});
console.log("\noutcome:", outcome);
console.log(
  "events:",
  (await journal.read(session.id)).map((event) => event.type),
);
