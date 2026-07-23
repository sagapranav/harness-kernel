// Run with:
//   npm install && npm run build && node dist/examples/durable-worker.js
//
// The full durable composition the kernel exists for: a queue delivery, a
// fenced session lease, expected-head appends, a bounded deadline checkpoint,
// and a continuation that finishes the run in a second delivery. Swap the
// memory adapters for durable implementations that pass the conformance
// suites and the same code runs across machines.
import {
  MemoryFencedJournalStore,
  MemorySessionCatalog,
  MemoryWorkQueue,
  SessionManager,
  SessionWorkDispatcher,
  WorkerHost,
  bindExecutionLease,
  createId,
  messageEvent,
  nowIso,
  runAgentLoop,
  type ActionExecutor,
  type ExecutionLease,
  type ImmutableRunConfig,
  type ModelInvoker,
  type WorkResolution,
} from "@sagapranav/harness-kernel";

const journal = new MemoryFencedJournalStore();
const sessions = new SessionManager(journal, new MemorySessionCatalog());
const queue = new MemoryWorkQueue();
const dispatcher = new SessionWorkDispatcher(sessions, queue);

const config: ImmutableRunConfig = {
  id: "durable-config-v1",
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "example", model: "deterministic-demo" },
  tools: [
    {
      name: "step",
      description: "One unit of work.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

const session = await sessions.create(config, {
  purpose: "Finish a three-step task across two deliveries",
});
await journal.append(
  session.id,
  messageEvent({
    id: createId("msg"),
    role: "user",
    createdAt: nowIso(),
    content: [{ type: "text", text: "Do three steps of work." }],
  }),
);
await dispatcher.dispatch(session.id);

// A deterministic stand-in for a provider adapter. Because the journal is
// authoritative, the continuation only needs the durable history to resume.
let invocations = 0;
const model: ModelInvoker = {
  async invoke() {
    invocations += 1;
    const remaining = invocations <= 3;
    return {
      message: {
        id: createId("msg"),
        role: "assistant",
        createdAt: nowIso(),
        content: remaining
          ? [
              {
                type: "tool_call",
                id: `step-${invocations}`,
                name: "step",
                input: {},
              },
            ]
          : [{ type: "text", text: "All three steps are done." }],
      },
      telemetry: {
        provider: "example",
        model: "deterministic-demo",
        latencyMs: 0,
        stopReason: remaining ? "tool_use" : "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  },
};
const actions: ActionExecutor = {
  async execute(invocation) {
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [{ type: "text", text: `finished ${invocation.call.id}` }],
    };
  },
};

// Each delivery owns the session through a fenced lease and runs a bounded
// number of turns, then checkpoints so the queue can redeliver the rest.
function worker(workerId: string, turnBudget: number): WorkerHost {
  return new WorkerHost({
    queue,
    workerId,
    capabilities: ["agent"],
    visibilityTimeoutMs: 60_000,
    handlers: {
      "agent.run": {
        async handle(item, context): Promise<WorkResolution> {
          let lease: ExecutionLease | null =
            await journal.acquireExecutionLease({
              sessionId: item.sessionId,
              ownerId: workerId,
              durationMs: 60_000,
            });
          if (lease === null) {
            return {
              status: "failed",
              message: "another worker owns the session",
              retryable: true,
            };
          }
          let turnsThisDelivery = 0;
          try {
            const outcome = await runAgentLoop({
              sessionId: item.sessionId,
              config,
              // Every append made by the loop is fenced by the lease and
              // compare-and-appended against the tracked head.
              journal: bindExecutionLease(journal, lease),
              model,
              actions,
              beforeTurn: async () => {
                await context.heartbeat();
                lease = await journal.renewExecutionLease(lease!, 60_000);
                turnsThisDelivery += 1;
              },
              shouldCheckpoint: () =>
                turnsThisDelivery >= turnBudget
                  ? "delivery turn budget reached"
                  : null,
            });
            if (outcome.status === "completed") {
              return { status: "completed", result: outcome };
            }
            if (outcome.status === "checkpointed") {
              return { status: "checkpointed", reason: outcome.reason };
            }
            return {
              status: "failed",
              message: `run ended with ${outcome.status}`,
              retryable: false,
            };
          } finally {
            await journal.releaseExecutionLease(lease);
          }
        },
      },
    },
  });
}

const first = await worker("machine-a", 2).runOne();
console.log("first delivery:", first);
const second = await worker("machine-b", 10).runOne();
console.log("second delivery:", second);
console.log(
  "final transcript:",
  (await sessions.project(session.id)).messages.map((message) =>
    message.content.map((block) =>
      block.type === "text" ? block.text : block.type,
    ),
  ),
);
