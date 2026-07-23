import {
  MemoryWorkQueue,
  SessionManager,
  SessionWorkDispatcher,
  WorkerHost,
  createMemoryStorage,
  nowIso,
  type ImmutableRunConfig,
} from "@sagapranav/harness-kernel";

const storage = createMemoryStorage();
const sessions = new SessionManager(storage.journal, storage.sessions);
const queue = new MemoryWorkQueue();
const dispatcher = new SessionWorkDispatcher(sessions, queue);

const managerConfig: ImmutableRunConfig = {
  id: "manager-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "anthropic", model: "your-manager-model" },
  tools: [],
};
const browserConfig: ImmutableRunConfig = {
  id: "browser-worker-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "openai", model: "your-browser-model" },
  tools: [],
};

const manager = await sessions.create(managerConfig, {
  purpose: "Coordinate independent evidence collection",
});
const dispatched = await dispatcher.forkAndDispatch(
  manager.id,
  browserConfig,
  { id: "child-inspect-account-portal", purpose: "Inspect the account portal" },
  { requiredCapabilities: ["agent", "browser"] },
);

const browserWorker = new WorkerHost({
  queue,
  workerId: "browser-machine-1",
  capabilities: ["agent", "browser"],
  visibilityTimeoutMs: 60_000,
  handlers: {
    "agent.run": {
      async handle(item, context) {
        await context.heartbeat();
        // A real handler loads item.sessionId and its immutable config, obtains
        // a fenced journal lease, then calls runAgentLoop().
        return {
          status: "completed",
          result: { sessionId: item.sessionId },
        };
      },
    },
  },
});

console.log({
  childSessionId: dispatched.session.id,
  worker: await browserWorker.runOne(),
});
