// Run with:
//   npm install && npm run build && node dist/examples/manager-workers.js
//
// Agents and tools together. The manager is an ordinary session whose action
// surface includes a `spawn_agent` tool: the model decides to delegate, the
// tool's executor forks a capability-routed child session and enqueues it,
// a worker host runs the child (which uses its own tool), and the child's
// conclusion returns to the manager as one model-visible observation. Which
// provider runs each session is configuration, not an orchestration
// primitive — the manager is Anthropic-configured and the worker
// OpenAI-configured here purely to show they can differ. Both models are
// deterministic stand-ins so the example runs offline.
import {
  MemoryWorkQueue,
  SessionManager,
  SessionWorkDispatcher,
  WorkerHost,
  createId,
  createMemoryStorage,
  messageEvent,
  nowIso,
  runAgentLoop,
  type ActionExecutor,
  type ContentBlock,
  type ImmutableRunConfig,
  type ModelInvoker,
} from "@sagapranav/harness-kernel";

const storage = createMemoryStorage();
const sessions = new SessionManager(storage.journal, storage.sessions);
const queue = new MemoryWorkQueue();
const dispatcher = new SessionWorkDispatcher(sessions, queue);

// A deterministic stand-in for a provider adapter: each invocation returns
// the next scripted turn; tool calls imply a tool_use stop.
function scripted(provider: string, turns: ContentBlock[][]): ModelInvoker {
  let turn = 0;
  return {
    async invoke() {
      const content = turns[Math.min(turn, turns.length - 1)]!;
      turn += 1;
      const hasCalls = content.some((block) => block.type === "tool_call");
      return {
        message: {
          id: createId("msg"),
          role: "assistant",
          createdAt: nowIso(),
          content,
        },
        telemetry: {
          provider,
          model: "deterministic-demo",
          latencyMs: 0,
          stopReason: hasCalls ? "tool_use" : "end",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      };
    },
  };
}

// ---- The worker: its own config, tool, and executor ----

const workerConfig: ImmutableRunConfig = {
  id: "browser-worker-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "openai", model: "your-browser-model" },
  tools: [
    {
      name: "inspect_page",
      description: "Fetch a page and report what its forms submit.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  ],
};

const workerModel = scripted("openai", [
  [
    {
      type: "tool_call",
      id: "inspect-1",
      name: "inspect_page",
      input: { url: "https://portal.example/login" },
    },
  ],
  [
    {
      type: "text",
      text: "The login form posts credentials to http://portal.example/session without TLS.",
    },
  ],
]);

const workerActions: ActionExecutor = {
  async execute(invocation) {
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [
        {
          type: "text",
          text: '<form action="http://portal.example/session" method="post"> (no TLS)',
        },
      ],
    };
  },
};

// ---- The manager: spawning a child agent is just another tool ----

const managerConfig: ImmutableRunConfig = {
  id: "manager-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "anthropic", model: "your-manager-model" },
  tools: [
    {
      name: "spawn_agent",
      description:
        "Delegate a task to an isolated child agent with its own context window. Returns the child session id; the child's conclusion arrives later as an observation.",
      inputSchema: {
        type: "object",
        properties: {
          purpose: { type: "string" },
          capability: { type: "string" },
        },
        required: ["purpose"],
      },
    },
  ],
};

const managerModel = scripted("anthropic", [
  [
    {
      type: "tool_call",
      id: "spawn-1",
      name: "spawn_agent",
      input: {
        purpose: "Inspect the account portal login flow",
        capability: "browser",
      },
    },
  ],
  [{ type: "text", text: "Dispatched a browser worker; awaiting findings." }],
  [
    {
      type: "text",
      text: "Confirmed: the portal login form submits credentials over plain HTTP.",
    },
  ],
]);

const managerActions: ActionExecutor = {
  async execute(invocation) {
    if (invocation.call.name !== "spawn_agent") {
      return {
        invocationId: invocation.invocationId,
        status: "failed",
        content: [
          { type: "text", text: `unknown tool ${invocation.call.name}` },
        ],
      };
    }
    const input = invocation.call.input as {
      purpose?: string;
      capability?: string;
    };
    // A stable child id derived from the tool call keeps a retried spawn
    // idempotent: forkAndDispatch recovers instead of duplicating the child.
    const dispatched = await dispatcher.forkAndDispatch(
      invocation.sessionId,
      workerConfig,
      {
        id: `child_${invocation.call.id}`,
        purpose: input.purpose,
        // The manager loop owns the manager journal for this turn, so the
        // spawn tool must not write child.started to it — the loop records
        // this spawn as the action receipt instead.
        linkInParent: false,
      },
      { requiredCapabilities: ["agent", input.capability ?? "browser"] },
    );
    await storage.journal.append(
      dispatched.session.id,
      messageEvent({
        id: createId("msg"),
        role: "user",
        createdAt: nowIso(),
        content: [{ type: "text", text: `Task: ${input.purpose}` }],
      }),
    );
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [
        {
          type: "text",
          text: `Dispatched child session ${dispatched.session.id} as work item ${dispatched.work.item.id}.`,
        },
      ],
    };
  },
};

// ---- The worker host: loads durable state after claiming, runs the child ----

const browserWorker = new WorkerHost({
  queue,
  workerId: "browser-machine-1",
  capabilities: ["agent", "browser"],
  visibilityTimeoutMs: 60_000,
  handlers: {
    "agent.run": {
      async handle(item, context) {
        await context.heartbeat();
        const child = await storage.sessions.getSession(item.sessionId);
        const config = await storage.sessions.getConfig(child!.configId);
        const outcome = await runAgentLoop({
          sessionId: item.sessionId,
          config: config!,
          journal: storage.journal,
          model: workerModel,
          actions: workerActions,
          // Inherited-context projection: the child sees the manager's
          // transcript through its fork point without copying any events.
          project: () => sessions.project(item.sessionId),
        });
        if (outcome.status !== "completed") {
          return {
            status: "failed",
            message: `child run ended with ${outcome.status}`,
            retryable: false,
          };
        }
        const conclusion = (await sessions.project(item.sessionId)).messages
          .at(-1)
          ?.content.find((block) => block.type === "text");
        await sessions.completeChild(child!.parentSessionId!, {
          childSessionId: item.sessionId,
          status: "completed",
          conclusion: conclusion?.type === "text" ? conclusion.text : undefined,
          confidence: 0.9,
          evidenceRefs: [],
          artifactRefs: [],
        });
        return { status: "completed", result: { sessionId: item.sessionId } };
      },
    },
  },
});

// ---- The composition ----

const manager = await sessions.create(managerConfig, {
  purpose: "Coordinate independent evidence collection",
});
await storage.journal.append(
  manager.id,
  messageEvent({
    id: createId("msg"),
    role: "user",
    createdAt: nowIso(),
    content: [
      { type: "text", text: "Check the account portal for security problems." },
    ],
  }),
);

console.log(
  "manager run 1:",
  await runAgentLoop({
    sessionId: manager.id,
    config: managerConfig,
    journal: storage.journal,
    model: managerModel,
    actions: managerActions,
  }),
);
console.log("worker delivery:", await browserWorker.runOne());
console.log(
  "manager run 2:",
  await runAgentLoop({
    sessionId: manager.id,
    config: managerConfig,
    journal: storage.journal,
    model: managerModel,
    actions: managerActions,
  }),
);

console.log("\nmanager transcript:");
for (const message of (await sessions.project(manager.id)).messages) {
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join(" ");
  console.log(`  ${message.role}: ${text}`);
}
