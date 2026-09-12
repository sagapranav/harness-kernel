import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  checkMailboxStore,
  checkOrchestration,
  compactionEvent,
  createMemoryStorage,
  defaultRuntime,
  EVENT_TYPES,
  JournalConflictError,
  MailboxConflictError,
  MemoryFencedJournalStore,
  MemoryMailboxStore,
  MemoryWorkQueue,
  messageEvent,
  projectContext,
  receiveMailbox,
  runAgentLoop,
  SessionManager,
  bindExecutionLease,
  waitForMailbox,
  toOpenAIInput,
  toOpenAIChatInput,
  toAnthropicInput,
  type ContentBlock,
  type ImmutableRunConfig,
  type MailboxDelivery,
  type MailboxMessage,
  type MailboxStore,
  type ModelInvoker,
  type ModelRequest,
  type JournalStore,
} from "../src/index.js";
import { FileMailboxStore, JsonlJournalStore } from "../src/node.js";

function mail(id: string, to = "parent", from = "child"): MailboxMessage {
  return {
    id,
    senderSessionId: from,
    recipientSessionId: to,
    createdAt: "2026-01-01T00:00:00.000Z",
    body: { type: "message", content: [{ type: "text", text: `note ${id}` }] },
  };
}

function withAck(
  store: MailboxStore,
  acknowledge: MailboxStore["acknowledge"],
): MailboxStore {
  return {
    profile: store.profile,
    send: (value) => store.send(value),
    get: (id) => store.get(id),
    read: (id, options) => store.read(id, options),
    acknowledge,
    pendingRecipients: () => store.pendingRecipients(),
  };
}

function fixture() {
  const storage = createMemoryStorage();
  const sessions = new SessionManager(storage.journal, storage.sessions);
  const mailbox = new MemoryMailboxStore();
  const config: ImmutableRunConfig = {
    id: "config",
    version: 1,
    createdAt: defaultRuntime.nowIso(),
    provider: { provider: "test", model: "test" },
    tools: [],
  };
  const actions = {
    async execute(invocation: { invocationId: string }) {
      return {
        invocationId: invocation.invocationId,
        status: "succeeded" as const,
        content: [{ type: "text" as const, text: "done" }],
      };
    },
  };
  return { storage, sessions, mailbox, config, actions };
}

function model(
  invoke: (request: ModelRequest) => Promise<ContentBlock[]>,
): ModelInvoker {
  return {
    async invoke(request) {
      const content = await invoke(request);
      return {
        message: {
          id: defaultRuntime.createId("msg"),
          role: "assistant" as const,
          createdAt: defaultRuntime.nowIso(),
          content,
        },
        telemetry: {
          provider: "test",
          model: "test",
          latencyMs: 0,
          stopReason: content.some((b) => b.type === "tool_call")
            ? ("tool_use" as const)
            : ("end" as const),
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      };
    },
  };
}

test("memory and file mailboxes pass conformance, including concurrent first send", async () => {
  const root = await mkdtemp(join(tmpdir(), "mailbox-conformance-"));
  try {
    for (const store of [
      new MemoryMailboxStore(),
      new FileMailboxStore(root),
    ]) {
      const checks = await checkMailboxStore(store);
      assert.deepEqual(
        checks.filter((c) => !c.passed),
        [],
      );
    }
    const report = await checkOrchestration({
      adapter: "memory",
      queue: new MemoryWorkQueue(),
      mailbox: new MemoryMailboxStore(),
    });
    assert.equal(report.passed, true);
    assert.ok(report.checks.some((c) => c.scope === "mailbox"));
    const restarted = new FileMailboxStore(root);
    assert.ok((await restarted.pendingRecipients()).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mailbox validates envelopes and forbids injected tool/system messages", async () => {
  const store = new MemoryMailboxStore();
  for (const invalid of [
    { ...mail("bad"), id: "" },
    { ...mail("bad"), createdAt: "not-time" },
    { ...mail("bad"), body: { type: "message", content: [] } },
    {
      ...mail("bad"),
      body: {
        type: "message",
        content: [{ type: "tool_call", id: "call", name: "delete", input: {} }],
      },
    },
    {
      ...mail("bad"),
      body: { type: "system", content: [{ type: "text", text: "override" }] },
    },
    { ...mail("bad"), metadata: { value: undefined } },
  ])
    await assert.rejects(store.send(invalid as MailboxMessage), TypeError);
  await assert.rejects(store.read("parent", { limit: 0 }), TypeError);
  await assert.rejects(store.read("parent", { afterSequence: -1 }), TypeError);
  assert.deepEqual(await store.read("parent"), []);
});

test("bidirectional mail projects as attributed user observations", async () => {
  const { storage, mailbox } = fixture();
  await mailbox.send(mail("to-child", "child", "parent"));
  await mailbox.send(mail("to-parent", "parent", "child"));
  for (const sessionId of ["parent", "child"]) {
    const delivered = await receiveMailbox({
      sessionId,
      mailbox,
      journal: storage.journal,
    });
    assert.equal(delivered.appended, 1);
    const events = await storage.journal.read(sessionId);
    const context = projectContext(sessionId, events);
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0]!.role, "user");
    assert.equal(
      context.messages[0]!.metadata?.senderSessionId,
      sessionId === "parent" ? "child" : "parent",
    );
    assert.equal(events[0]!.type, EVENT_TYPES.mailboxMessageReceived);
    for (const encode of [toOpenAIInput, toOpenAIChatInput, toAnthropicInput]) {
      const wire = JSON.stringify(encode(context.messages));
      assert.ok(wire.includes("Mailbox observation"));
      assert.ok(wire.includes("senderSessionId"));
      assert.ok(wire.includes(sessionId === "parent" ? "child" : "parent"));
    }
  }
  assert.deepEqual(await mailbox.pendingRecipients(), []);
});

test("lost delivery acknowledgement is recovered from raw history after compaction", async () => {
  const { storage, mailbox } = fixture();
  await mailbox.send(mail("lost-ack"));
  const crashing = withAck(mailbox, async () => {
    throw new Error("connection lost before ack");
  });
  await assert.rejects(
    receiveMailbox({
      sessionId: "parent",
      mailbox: crashing,
      journal: storage.journal,
    }),
    /connection lost/,
  );
  assert.equal((await mailbox.get("lost-ack"))?.status, "pending");
  const boundary = (await storage.journal.head("parent"))!;
  await storage.journal.append(
    "parent",
    compactionEvent({
      summarizesThroughEventId: boundary.id,
      evidenceRefs: [],
      scope: "local",
      projectorVersion: 1,
      summary: {
        id: "summary",
        role: "user",
        createdAt: defaultRuntime.nowIso(),
        content: [{ type: "text", text: "summary" }],
      },
    }),
  );
  const repaired = await receiveMailbox({
    sessionId: "parent",
    mailbox,
    journal: storage.journal,
  });
  assert.equal(repaired.appended, 0);
  assert.equal(repaired.acknowledged, 1);
  assert.equal((await mailbox.get("lost-ack"))?.delivery?.eventId, boundary.id);
  assert.equal((await storage.journal.read("parent")).length, 2);
});

test("an acknowledgement committed before its response is lost does not redeliver", async () => {
  const { storage, mailbox } = fixture();
  await mailbox.send(mail("ack-response-lost"));
  const crashing = withAck(mailbox, async (id, delivery) => {
    await mailbox.acknowledge(id, delivery);
    throw new Error("response lost");
  });
  await assert.rejects(
    receiveMailbox({
      sessionId: "parent",
      mailbox: crashing,
      journal: storage.journal,
    }),
    /response lost/,
  );
  assert.equal(
    (
      await receiveMailbox({
        sessionId: "parent",
        mailbox,
        journal: storage.journal,
      })
    ).appended,
    0,
  );
  assert.equal((await storage.journal.read("parent")).length, 1);
});

test("failed journal append leaves mail pending", async () => {
  const { storage, mailbox } = fixture();
  await mailbox.send(mail("pending"));
  await assert.rejects(
    receiveMailbox({
      sessionId: "parent",
      mailbox,
      journal: storage.journal,
      append: async () => {
        throw new JournalConflictError(null, "foreign");
      },
    }),
    JournalConflictError,
  );
  assert.equal((await mailbox.get("pending"))?.status, "pending");
  assert.equal((await storage.journal.read("parent")).length, 0);
});

test("journal ID collisions and conflicting child completions fail without acknowledging", async () => {
  const { storage, mailbox } = fixture();
  await mailbox.send(mail("collision"));
  await storage.journal.append("parent", {
    type: "unrelated.trace",
    category: "trace",
    data: { mailboxMessage: mail("collision") },
  });
  await assert.rejects(
    receiveMailbox({ sessionId: "parent", mailbox, journal: storage.journal }),
    MailboxConflictError,
  );
  assert.equal((await mailbox.get("collision"))?.status, "pending");
});

test("child results share completion semantics with completeChild and retain evidence", async () => {
  const { storage, sessions, config, mailbox } = fixture();
  const parent = await sessions.create(config, { id: "parent" });
  const child = await sessions.fork(parent.id, config, { id: "child" });
  const artifact = await storage.artifacts.put("evidence");
  const result = {
    childSessionId: child.id,
    status: "completed" as const,
    noneFound: true,
    evidenceRefs: [artifact],
    artifactRefs: [],
  };
  const message: MailboxMessage = {
    ...mail("result"),
    body: { type: "child_result", result },
  };
  await mailbox.send(message);
  await receiveMailbox({
    sessionId: parent.id,
    mailbox,
    journal: storage.journal,
  });
  await sessions.completeChild(parent.id, result);
  assert.equal(
    (await storage.journal.read(parent.id)).filter(
      (e) => e.type === EVENT_TYPES.childCompleted,
    ).length,
    1,
  );
  assert.deepEqual((await sessions.project(parent.id)).evidenceRefs, [
    artifact,
  ]);
  await mailbox.send({ ...message, id: "same-result" });
  assert.equal(
    (
      await receiveMailbox({
        sessionId: parent.id,
        mailbox,
        journal: storage.journal,
      })
    ).appended,
    0,
  );
  await mailbox.send({
    ...message,
    id: "conflict-result",
    body: { type: "child_result", result: { ...result, noneFound: false } },
  });
  await assert.rejects(
    receiveMailbox({ sessionId: parent.id, mailbox, journal: storage.journal }),
    MailboxConflictError,
  );
  assert.equal((await mailbox.get("conflict-result"))?.status, "pending");
  await assert.rejects(
    mailbox.send({
      ...message,
      id: "wrong-child",
      senderSessionId: "someone-else",
    }),
    TypeError,
  );
});

test("mail arriving during a model call is incorporated after its tools, before the next decision", async () => {
  const { storage, sessions, config, mailbox, actions } = fixture();
  const parent = await sessions.create(config, { id: "parent" });
  let turn = 0;
  const invoker = model(async (request) => {
    turn += 1;
    if (turn === 1) {
      await mailbox.send(mail("mid-call"));
      assert.equal(
        (await storage.journal.read(parent.id)).some(
          (e) => e.type === EVENT_TYPES.mailboxMessageReceived,
        ),
        false,
      );
      return [{ type: "tool_call", id: "search", name: "search", input: {} }];
    }
    assert.ok(
      request.context.messages.some(
        (m) => m.metadata?.mailboxMessageId === "mid-call",
      ),
    );
    return [{ type: "text", text: "considered finding" }];
  });
  const outcome = await runAgentLoop({
    sessionId: parent.id,
    config,
    journal: storage.journal,
    mailbox,
    model: invoker,
    actions,
  });
  assert.equal(outcome.status, "completed");
  assert.equal(turn, 2);
  const events = await storage.journal.read(parent.id);
  const received = events.findIndex(
    (e) => e.type === EVENT_TYPES.mailboxMessageReceived,
  );
  const toolResult = events.findIndex(
    (e) =>
      e.type === EVENT_TYPES.messageAppended &&
      (e.data as { message: { role: string } }).message.role === "tool",
  );
  assert.ok(received > toolResult);
});

test("a final response racing incoming mail triggers another decision within the turn budget", async () => {
  const { storage, sessions, config, mailbox, actions } = fixture();
  await sessions.create(config, { id: "parent" });
  let turns = 0;
  const outcome = await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    actions,
    model: model(async (request) => {
      turns += 1;
      if (turns === 1) await mailbox.send(mail("late"));
      else
        assert.ok(
          request.context.messages.some(
            (m) => m.metadata?.mailboxMessageId === "late",
          ),
        );
      return [{ type: "text", text: "answer" }];
    }),
  });
  assert.equal(outcome.status, "completed");
  assert.equal(turns, 2);
});

test("mail batches are bounded and maxTurns still limits a continuous conversation", async () => {
  const { storage, sessions, config, mailbox, actions } = fixture();
  await sessions.create(config, { id: "parent" });
  for (let n = 0; n < 5; n++) await mailbox.send(mail(`note-${n}`));
  const outcome = await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    actions,
    maxTurns: 1,
    maxMailboxMessagesPerTurn: 1,
    model: model(async (request) => {
      assert.equal(request.context.messages.length, 1);
      return [{ type: "text", text: "answer" }];
    }),
  });
  assert.equal(outcome.status, "limited");
  assert.equal((await mailbox.read("parent", { status: "pending" })).length, 3);
});

test("recovery does not mistake mail after a final answer for a lost final outcome", async () => {
  const { storage, sessions, config, mailbox, actions } = fixture();
  await sessions.create(config, { id: "parent" });
  let first = true;
  const crashJournal: JournalStore = {
    read: (id, options) => storage.journal.read(id, options),
    head: (id) => storage.journal.head(id),
    append: async (id, input, options) => {
      if (input.type === EVENT_TYPES.modelCallStarted && !first)
        throw new Error("crash before next call");
      if (input.type === EVENT_TYPES.modelCallStarted) first = false;
      return storage.journal.append(id, input, options);
    },
  };
  await assert.rejects(
    runAgentLoop({
      sessionId: "parent",
      config,
      journal: crashJournal,
      mailbox,
      actions,
      model: model(async () => {
        await mailbox.send(mail("after-answer"));
        return [{ type: "text", text: "old answer" }];
      }),
    }),
    /crash before next call/,
  );
  let resumed = false;
  const result = await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    actions,
    model: model(async (request) => {
      resumed = true;
      assert.ok(
        request.context.messages.some(
          (m) => m.metadata?.mailboxMessageId === "after-answer",
        ),
      );
      return [{ type: "text", text: "updated answer" }];
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(resumed, true);
});

test("a recovered final outcome does not strand pending mail", async () => {
  const { storage, sessions, config, mailbox, actions } = fixture();
  await sessions.create(config, { id: "parent" });
  const crashJournal: JournalStore = {
    read: (id, options) => storage.journal.read(id, options),
    head: (id) => storage.journal.head(id),
    append: async (id, input, options) => {
      if (input.type === EVENT_TYPES.runCompleted)
        throw new Error("lost outcome");
      return storage.journal.append(id, input, options);
    },
  };
  await assert.rejects(
    runAgentLoop({
      sessionId: "parent",
      config,
      journal: crashJournal,
      actions,
      model: model(async () => [{ type: "text", text: "old answer" }]),
    }),
    /lost outcome/,
  );
  await mailbox.send(mail("new-info"));
  let invoked = false;
  await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    actions,
    model: model(async (request) => {
      invoked = true;
      assert.ok(
        request.context.messages.some(
          (m) => m.metadata?.mailboxMessageId === "new-info",
        ),
      );
      return [{ type: "text", text: "new answer" }];
    }),
  });
  assert.equal(invoked, true);
});

test("unresolved actions prevent mail from being injected into an incomplete tool exchange", async () => {
  const { storage, sessions, config, mailbox } = fixture();
  await sessions.create(config, { id: "parent" });
  const first = await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    model: model(async () => [
      { type: "tool_call", id: "effect", name: "effect", input: {} },
    ]),
    actions: {
      async execute(invocation) {
        await mailbox.send(mail("wait-for-reconciliation"));
        return {
          invocationId: invocation.invocationId,
          status: "unknown",
          content: [],
        };
      },
    },
  });
  assert.equal(first.status, "checkpointed");
  const next = await runAgentLoop({
    sessionId: "parent",
    config,
    journal: storage.journal,
    mailbox,
    model: model(async () => {
      throw new Error("must not invoke");
    }),
    actions: {
      async execute() {
        throw new Error("must not execute");
      },
    },
  });
  assert.equal(next.status, "checkpointed");
  assert.equal(
    (await mailbox.get("wait-for-reconciliation"))?.status,
    "pending",
  );
});

test("mail delivery preserves execution fencing and rejects a stale recipient", async () => {
  let time = Date.parse("2026-01-01T00:00:00Z");
  const runtime = {
    ...defaultRuntime,
    nowIso: () => new Date(time).toISOString(),
  };
  const journal = new MemoryFencedJournalStore(runtime);
  const mailbox = new MemoryMailboxStore(runtime);
  await mailbox.send(mail("fenced"));
  const old = (await journal.acquireExecutionLease({
    sessionId: "parent",
    ownerId: "a",
    durationMs: 10,
  }))!;
  time += 11;
  const current = (await journal.acquireExecutionLease({
    sessionId: "parent",
    ownerId: "b",
    durationMs: 100,
  }))!;
  await assert.rejects(
    receiveMailbox({
      sessionId: "parent",
      mailbox,
      journal: bindExecutionLease(journal, old),
    }),
    /execution lease/,
  );
  assert.equal((await mailbox.get("fenced"))?.status, "pending");
  await receiveMailbox({
    sessionId: "parent",
    mailbox,
    journal: bindExecutionLease(journal, current),
  });
  assert.equal((await journal.read("parent")).length, 1);
});

test("waiting detects already-arrived and later mail, times out, and cancels", async () => {
  const mailbox = new MemoryMailboxStore();
  assert.deepEqual(await waitForMailbox(mailbox, "parent", { timeoutMs: 0 }), {
    status: "timeout",
  });
  await mailbox.send(mail("already"));
  assert.equal(
    (await waitForMailbox(mailbox, "parent", { timeoutMs: 0 })).status,
    "available",
  );
  const later = waitForMailbox(mailbox, "other", {
    timeoutMs: 1000,
    pollIntervalMs: 2,
  });
  await mailbox.send(mail("later", "other"));
  assert.equal((await later).status, "available");
  const controller = new AbortController();
  const cancelled = waitForMailbox(mailbox, "empty", {
    timeoutMs: 1000,
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await cancelled, { status: "cancelled" });
  assert.deepEqual(
    await waitForMailbox(mailbox, "empty", { timeoutMs: 2, pollIntervalMs: 1 }),
    { status: "timeout" },
  );
  await assert.rejects(
    waitForMailbox(mailbox, "parent", { timeoutMs: -1 }),
    TypeError,
  );
  assert.equal((await mailbox.get("already"))?.status, "pending");
});

test("file mailbox and journal recover after a recipient process exits before acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mailbox-crash-"));
  try {
    const core = pathToFileURL(resolve("dist/src/index.js")).href;
    const node = pathToFileURL(resolve("dist/src/node.js")).href;
    const source = `
      import { receiveMailbox } from ${JSON.stringify(core)};
      import { FileMailboxStore, JsonlJournalStore } from ${JSON.stringify(node)};
      const root = process.argv[1];
      const mailbox = new FileMailboxStore(root + '/mail');
      const journal = new JsonlJournalStore(root + '/journals');
      await mailbox.send(${JSON.stringify(mail("crash"))});
      mailbox.acknowledge = async () => process.exit(17);
      await receiveMailbox({ sessionId: 'parent', mailbox, journal });
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source, root],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 17, child.stderr);
    const mailbox = new FileMailboxStore(join(root, "mail"));
    const journal = new JsonlJournalStore(join(root, "journals"));
    assert.deepEqual(await mailbox.pendingRecipients(), ["parent"]);
    assert.equal((await journal.read("parent")).length, 1);
    const recovered = await receiveMailbox({
      sessionId: "parent",
      mailbox,
      journal,
    });
    assert.equal(recovered.appended, 0);
    assert.equal(recovered.acknowledged, 1);
    assert.equal(
      (await new FileMailboxStore(join(root, "mail")).get("crash"))?.status,
      "delivered",
    );
    await writeFile(join(root, "mail", "orphan.tmp"), "{partial");
    assert.equal(
      (await new FileMailboxStore(join(root, "mail")).get("crash"))?.status,
      "delivered",
    );
    const snapshot = await readFile(join(root, "mail", "mailbox.json"), "utf8");
    assert.equal(JSON.parse(snapshot).version, 1);
    await writeFile(join(root, "mail", "mailbox.json"), "{corrupt");
    await assert.rejects(
      new FileMailboxStore(join(root, "mail")).get("crash"),
      SyntaxError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mailbox snapshot restoration rejects broken sequence, recipient and version", () => {
  const valid = {
    message: mail("snap"),
    sequence: 1,
    acceptedAt: defaultRuntime.nowIso(),
    status: "pending" as const,
  };
  assert.throws(
    () =>
      new MemoryMailboxStore(defaultRuntime, {
        version: 2 as 1,
        records: [valid],
      }),
    /unsupported/,
  );
  assert.throws(
    () =>
      new MemoryMailboxStore(defaultRuntime, {
        version: 1,
        records: [{ ...valid, sequence: 2 }],
      }),
    /sequence/,
  );
  const delivery: MailboxDelivery = {
    sessionId: "wrong",
    eventId: "event",
    sequence: 1,
    deliveredAt: defaultRuntime.nowIso(),
  };
  assert.throws(
    () =>
      new MemoryMailboxStore(defaultRuntime, {
        version: 1,
        records: [{ ...valid, status: "delivered", delivery }],
      }),
    /recipient/,
  );
});
