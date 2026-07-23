import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryJournalStore,
  createId,
  foldProjection,
  messageEvent,
  nowIso,
  projectContext,
  runAgentLoop,
  telemetryProjection,
  type ActionExecutor,
  type ActionInvocation,
  type ImmutableRunConfig,
  type ModelInvoker,
} from "../src/index.js";

const config: ImmutableRunConfig = {
  id: "loop-config",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  provider: { provider: "test", model: "test-model" },
  tools: [
    { name: "slow", description: "slow", inputSchema: { type: "object" } },
    { name: "fast", description: "fast", inputSchema: { type: "object" } },
  ],
};

test("loop records completion-order receipts and source-order tool messages", async () => {
  const journal = new MemoryJournalStore();
  let modelCalls = 0;
  const seenToolOrder: string[][] = [];
  const model: ModelInvoker = {
    async invoke(request) {
      modelCalls += 1;
      seenToolOrder.push(
        request.context.messages.flatMap((message) =>
          message.content
            .filter((block) => block.type === "tool_result")
            .map(
              (block) =>
                (block as { type: "tool_result"; name?: string }).name ?? "",
            ),
        ),
      );
      return {
        message: {
          id: createId("msg"),
          role: "assistant",
          createdAt: nowIso(),
          content:
            modelCalls === 1
              ? [
                  {
                    type: "tool_call",
                    id: "slow-call",
                    name: "slow",
                    input: {},
                  },
                  {
                    type: "tool_call",
                    id: "fast-call",
                    name: "fast",
                    input: {},
                  },
                ]
              : [{ type: "text", text: "done" }],
        },
        telemetry: {
          provider: "test",
          model: "test-model",
          latencyMs: 5,
          stopReason: modelCalls === 1 ? "tool_use" : "end",
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      };
    },
  };
  const actions: ActionExecutor = {
    async execute(invocation) {
      if (invocation.call.name === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return {
        invocationId: invocation.invocationId,
        status: "succeeded",
        content: [{ type: "text", text: invocation.call.name }],
      };
    },
  };

  const outcome = await runAgentLoop({
    sessionId: "loop-session",
    config,
    journal,
    model,
    actions,
  });
  assert.deepEqual(outcome, { status: "completed", turns: 2 });
  assert.deepEqual(seenToolOrder[1], ["slow", "fast"]);

  const events = await journal.read("loop-session");
  const completionNames = events
    .filter((event) => event.type === "action.completed")
    .map((event) => {
      const data = event.data as { invocation: { call: { name: string } } };
      return data.invocation.call.name;
    });
  assert.deepEqual(completionNames, ["fast", "slow"]);

  const context = projectContext("loop-session", events);
  const toolNames = context.messages.flatMap((message) =>
    message.content
      .filter((block) => block.type === "tool_result")
      .map((block) => (block as { type: "tool_result"; name?: string }).name),
  );
  assert.deepEqual(toolNames, ["slow", "fast"]);

  const telemetry = foldProjection("loop-session", events, telemetryProjection);
  assert.equal(telemetry.state.modelCalls, 2);
  assert.equal(telemetry.state.actionCalls, 2);
  assert.equal(telemetry.state.inputTokens, 20);
});

test("loop rejects duplicate tool calls before executing actions", async () => {
  const journal = new MemoryJournalStore();
  let executions = 0;
  const outcome = await runAgentLoop({
    sessionId: "duplicates",
    config,
    journal,
    model: {
      async invoke() {
        return {
          message: {
            id: "duplicate-message",
            role: "assistant",
            createdAt: nowIso(),
            content: [
              { type: "tool_call", id: "same", name: "fast", input: {} },
              { type: "tool_call", id: "same", name: "slow", input: {} },
            ],
          },
          telemetry: {
            provider: "test",
            model: "test",
            latencyMs: 0,
            stopReason: "tool_use",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      },
    },
    actions: {
      async execute(invocation) {
        executions += 1;
        return {
          invocationId: invocation.invocationId,
          status: "succeeded",
          content: [],
        };
      },
    },
  });

  assert.equal(outcome.status, "failed");
  assert.equal(executions, 0);
  assert.equal(
    (await journal.read("duplicates")).some(
      (event) => event.type === "model.protocol.error",
    ),
    true,
  );
});

test("loop records malformed model payloads as protocol failures", async () => {
  for (const [sessionId, response] of [
    [
      "malformed-content",
      {
        message: {
          id: "malformed",
          role: "assistant",
          createdAt: nowIso(),
          content: [null],
        },
        telemetry: {
          provider: "test",
          model: "test",
          latencyMs: 0,
          stopReason: "end",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ],
    [
      "malformed-telemetry",
      {
        message: {
          id: "malformed",
          role: "assistant",
          createdAt: nowIso(),
          content: [{ type: "text", text: "invalid telemetry" }],
        },
        telemetry: {
          provider: "test",
          model: "test",
          latencyMs: -1,
          stopReason: "invented",
          usage: { inputTokens: 0.5, outputTokens: 0 },
        },
      },
    ],
  ] as const) {
    const journal = new MemoryJournalStore();
    const outcome = await runAgentLoop({
      sessionId,
      config,
      journal,
      model: {
        async invoke() {
          return response as never;
        },
      },
      actions: {
        async execute() {
          throw new Error("must not execute");
        },
      },
    });
    assert.equal(outcome.status, "failed");
    assert.equal(
      (await journal.read(sessionId)).some(
        (event) => event.type === "model.protocol.error",
      ),
      true,
    );
  }

  await assert.rejects(
    runAgentLoop({
      sessionId: "invalid-limit",
      config,
      journal: new MemoryJournalStore(),
      model: {
        async invoke() {
          throw new Error("must not execute");
        },
      },
      actions: {
        async execute() {
          throw new Error("must not execute");
        },
      },
      maxTurns: Number.POSITIVE_INFINITY,
    }),
    /maxTurns/,
  );
});

test("loop checkpoints ambiguous provider stops and invalid receipts become failures", async () => {
  const pausedJournal = new MemoryJournalStore();
  const paused = await runAgentLoop({
    sessionId: "paused",
    config,
    journal: pausedJournal,
    model: {
      async invoke() {
        return {
          message: {
            id: "paused-message",
            role: "assistant",
            createdAt: nowIso(),
            content: [],
          },
          telemetry: {
            provider: "anthropic",
            model: "test",
            latencyMs: 0,
            stopReason: "pause",
            usage: { inputTokens: 1, outputTokens: 0 },
          },
        };
      },
    },
    actions: {
      async execute() {
        throw new Error("must not execute");
      },
    },
  });
  assert.equal(paused.status, "checkpointed");

  const receiptJournal = new MemoryJournalStore();
  let calls = 0;
  await runAgentLoop({
    sessionId: "bad-receipt",
    config,
    journal: receiptJournal,
    model: {
      async invoke() {
        calls += 1;
        return {
          message: {
            id: createId("msg"),
            role: "assistant",
            createdAt: nowIso(),
            content:
              calls === 1
                ? [
                    {
                      type: "tool_call",
                      id: "receipt-call",
                      name: "fast",
                      input: {},
                    },
                  ]
                : [{ type: "text", text: "observed failure" }],
          },
          telemetry: {
            provider: "test",
            model: "test",
            latencyMs: 0,
            stopReason: calls === 1 ? "tool_use" : "end",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      },
    },
    actions: {
      async execute() {
        return { invocationId: "wrong", status: "succeeded", content: [] };
      },
    },
  });
  const receiptEvent = (await receiptJournal.read("bad-receipt")).find(
    (event) => event.type === "action.completed",
  );
  assert.equal(
    (receiptEvent?.data as { receipt: { status: string } }).receipt.status,
    "failed",
  );
});

test("loop detects interrupted actions and repairs terminal receipts missing context", async () => {
  const interrupted = new MemoryJournalStore();
  const call = {
    type: "tool_call" as const,
    id: "crash-call",
    name: "fast",
    input: {},
  };
  await interrupted.append(
    "interrupted",
    messageEvent({
      id: "assistant-call",
      role: "assistant",
      createdAt: nowIso(),
      content: [call],
    }),
  );
  let modelCalls = 0;
  const checkpoint = await runAgentLoop({
    sessionId: "interrupted",
    config,
    journal: interrupted,
    model: {
      async invoke() {
        modelCalls += 1;
        throw new Error("must not be reached");
      },
    },
    actions: {
      async execute() {
        throw new Error("must not be reached");
      },
    },
  });
  assert.equal(checkpoint.status, "checkpointed");
  assert.equal(modelCalls, 0);

  const repair = new MemoryJournalStore();
  const invocation: ActionInvocation = {
    invocationId: "invocation-crash",
    sessionId: "repair",
    turnId: "turn-crash",
    call,
    idempotencyKey: "repair:crash-call",
  };
  await repair.append(
    "repair",
    messageEvent({
      id: "assistant-call-repair",
      role: "assistant",
      createdAt: nowIso(),
      content: [call],
    }),
  );
  await repair.append("repair", {
    category: "trace",
    type: "action.started",
    turnId: invocation.turnId,
    data: { invocation },
  });
  await repair.append("repair", {
    category: "trace",
    type: "action.completed",
    turnId: invocation.turnId,
    data: {
      invocation,
      receipt: {
        invocationId: invocation.invocationId,
        status: "succeeded",
        content: [{ type: "text", text: "recovered result" }],
      },
    },
  });

  let sawRecoveredResult = false;
  const repairedOutcome = await runAgentLoop({
    sessionId: "repair",
    config,
    journal: repair,
    model: {
      async invoke(request) {
        sawRecoveredResult = request.context.messages.some((message) =>
          message.content.some(
            (block) =>
              block.type === "tool_result" &&
              block.content.some(
                (resultBlock) =>
                  resultBlock.type === "text" &&
                  resultBlock.text === "recovered result",
              ),
          ),
        );
        return {
          message: {
            id: "repair-finished",
            role: "assistant",
            createdAt: nowIso(),
            content: [{ type: "text", text: "done" }],
          },
          telemetry: {
            provider: "test",
            model: "test",
            latencyMs: 0,
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      },
    },
    actions: {
      async execute() {
        throw new Error("must not execute");
      },
    },
  });
  assert.equal(repairedOutcome.status, "completed");
  assert.equal(sawRecoveredResult, true);
});
