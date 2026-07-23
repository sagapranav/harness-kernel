// Run with:
//   npm install && npm run build && node dist/examples/render-viewer.js
//
// Builds a small manager + sub-agent session in memory and renders a
// self-contained HTML transcript viewer to ./session-viewer.html. Open that
// file in a browser: Overview (pinned config, system prompt, initial prompt,
// telemetry), Transcript (readable conversation with telemetry and inline
// images), and Raw (per-event JSONL). The session switcher opens sub-agents.
import { writeFile } from "node:fs/promises";
import {
  SessionManager,
  SessionWorkDispatcher,
  MemoryWorkQueue,
  createId,
  createMemoryStorage,
  messageEvent,
  nowIso,
  runAgentLoop,
  type ActionExecutor,
  type CanonicalMessage,
  type ImmutableRunConfig,
  type ModelInvoker,
} from "@sagapranav/harness-kernel";
import { renderSessionViewer } from "@sagapranav/harness-kernel/node";

const storage = createMemoryStorage();
const sessions = new SessionManager(storage.journal, storage.sessions);
const dispatcher = new SessionWorkDispatcher(sessions, new MemoryWorkQueue());

function scripted(
  provider: string,
  turns: CanonicalMessage["content"][],
): ModelInvoker {
  let turn = 0;
  return {
    async invoke() {
      const content = turns[Math.min(turn, turns.length - 1)]!;
      turn += 1;
      const hasCalls = content.some((b) => b.type === "tool_call");
      return {
        message: {
          id: createId("msg"),
          role: "assistant",
          createdAt: nowIso(),
          content,
        },
        telemetry: {
          provider,
          model: "demo",
          latencyMs: 10,
          stopReason: hasCalls ? "tool_use" : "end",
          usage: { inputTokens: 30 + turn * 8, outputTokens: 12 },
        },
      };
    },
  };
}

const workerConfig: ImmutableRunConfig = {
  id: "researcher-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "openai", model: "researcher" },
  systemPrompt: "Collect one concise finding and report it.",
  tools: [
    {
      name: "lookup",
      description: "Look up a fact.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};
const workerModel = scripted("openai", [
  [{ type: "tool_call", id: "look-1", name: "lookup", input: {} }],
  [{ type: "text", text: "The archive lists 3 matching records." }],
]);
const workerActions: ActionExecutor = {
  async execute(invocation) {
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [{ type: "text", text: "3 records" }],
    };
  },
};

const managerConfig: ImmutableRunConfig = {
  id: "manager-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "anthropic", model: "manager" },
  systemPrompt: "Delegate research to a sub-agent, then summarize the finding.",
  temperature: 0.3,
  tools: [
    {
      name: "spawn_researcher",
      description: "Delegate to a researcher sub-agent.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
  ],
};
const managerModel = scripted("anthropic", [
  [
    {
      type: "tool_call",
      id: "spawn-1",
      name: "spawn_researcher",
      input: { task: "count records" },
    },
  ],
  [{ type: "text", text: "Researcher dispatched; awaiting the count." }],
  [{ type: "text", text: "Summary: the archive holds 3 matching records." }],
]);
const managerActions: ActionExecutor = {
  async execute(invocation) {
    const dispatched = await dispatcher.forkAndDispatch(
      invocation.sessionId,
      workerConfig,
      {
        id: "child_" + invocation.call.id,
        purpose: "Count matching records",
        linkInParent: false,
      },
      { requiredCapabilities: ["agent"] },
    );
    await storage.journal.append(
      dispatched.session.id,
      messageEvent({
        id: createId("msg"),
        role: "user",
        createdAt: nowIso(),
        content: [{ type: "text", text: "Task: count matching records" }],
      }),
    );
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [{ type: "text", text: "Dispatched " + dispatched.session.id }],
    };
  },
};

const manager = await sessions.create(managerConfig, {
  purpose: "Records investigation",
});
await storage.journal.append(
  manager.id,
  messageEvent({
    id: createId("msg"),
    role: "user",
    createdAt: nowIso(),
    content: [
      { type: "text", text: "How many matching records are in the archive?" },
    ],
  }),
);

await runAgentLoop({
  sessionId: manager.id,
  config: managerConfig,
  journal: storage.journal,
  model: managerModel,
  actions: managerActions,
});
const child = (await storage.sessions.getSession("child_spawn-1"))!;
await runAgentLoop({
  sessionId: child.id,
  config: workerConfig,
  journal: storage.journal,
  model: workerModel,
  actions: workerActions,
  project: () => sessions.project(child.id),
});
const conclusion = (await sessions.project(child.id)).messages
  .at(-1)!
  .content.find((b) => b.type === "text");
await sessions.completeChild(manager.id, {
  childSessionId: child.id,
  status: "completed",
  conclusion: conclusion?.type === "text" ? conclusion.text : undefined,
  confidence: 0.9,
  evidenceRefs: [],
  artifactRefs: [],
});
await runAgentLoop({
  sessionId: manager.id,
  config: managerConfig,
  journal: storage.journal,
  model: managerModel,
  actions: managerActions,
});

const html = await renderSessionViewer(storage, manager.id, {
  title: "Records investigation",
});
await writeFile("session-viewer.html", html);
console.log(
  "Wrote session-viewer.html (" +
    html.length +
    " bytes). Open it in a browser.",
);
