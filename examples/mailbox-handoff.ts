// Build, then run: node dist/examples/mailbox-handoff.js
// Two children receive notes and return findings while the parent does its own
// work. Every session owns its journal; all cross-session writes use the mailbox.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  nowIso,
  runAgentLoop,
  SessionManager,
  waitForMailbox,
  type ActionExecutor,
  type ContentBlock,
  type ImmutableRunConfig,
  type ModelInvoker,
  type ModelRequest,
  type SessionDescriptor,
} from "@sagapranav/harness-kernel";
import {
  createFileStorage,
  FileMailboxStore,
} from "@sagapranav/harness-kernel/node";

const root = await mkdtemp(join(tmpdir(), "harness-mailbox-"));
const storage = createFileStorage(root);
const mailbox = new FileMailboxStore(join(root, "mailbox"));
const sessions = new SessionManager(storage.journal, storage.sessions);
const config: ImmutableRunConfig = {
  id: createId("config"),
  version: 1,
  createdAt: nowIso(),
  provider: { provider: "example", model: "deterministic-demo" },
  tools: [
    {
      name: "send_note",
      description: "Send a note to a research child.",
      inputSchema: { type: "object" },
    },
    {
      name: "research_background",
      description: "Investigate the wider market.",
      inputSchema: { type: "object" },
    },
  ],
};
const parent = await sessions.create(config, {
  purpose: "Compare two companies",
});
const children = await Promise.all(
  ["Company A", "Company B"].map((purpose) =>
    sessions.fork(parent.id, config, { purpose }),
  ),
);

function scripted(
  next: (request: ModelRequest) => Promise<ContentBlock[]>,
): ModelInvoker {
  return {
    async invoke(request) {
      const content = await next(request);
      return {
        message: {
          id: createId("msg"),
          role: "assistant",
          createdAt: nowIso(),
          content,
        },
        telemetry: {
          provider: "example",
          model: "deterministic-demo",
          latencyMs: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: content.some((block) => block.type === "tool_call")
            ? "tool_use"
            : "end",
        },
      };
    },
  };
}

async function runChild(child: SessionDescriptor): Promise<void> {
  // This is a bounded local wait, not a persisted worker or scheduler. A deployed
  // host would claim queued work and use pendingRecipients() for wake recovery.
  const wake = await waitForMailbox(mailbox, child.id, {
    timeoutMs: 5000,
    pollIntervalMs: 5,
  });
  if (wake.status !== "available")
    throw new Error(`child did not receive its task: ${wake.status}`);
  const outcome = await runAgentLoop({
    sessionId: child.id,
    config,
    journal: storage.journal,
    mailbox,
    project: () => sessions.project(child.id),
    model: scripted(async (request) => {
      const note = request.context.messages.find(
        (message) => message.metadata?.senderSessionId === parent.id,
      );
      if (note === undefined)
        throw new Error("parent's note was not incorporated");
      return [
        {
          type: "text",
          text: `${child.purpose}: enterprise pricing requires a quote.`,
        },
      ];
    }),
    actions: {
      async execute() {
        throw new Error("this scripted child has no tool calls");
      },
    },
  });
  if (outcome.status !== "completed")
    throw new Error(`child ended with ${outcome.status}`);
  const context = await sessions.project(child.id);
  const conclusion = context.messages
    .at(-1)!
    .content.find((block) => block.type === "text");
  // Stable identity and creation time make re-sending this same result safe.
  // A real adapter should derive the result from the child's committed history.
  await mailbox.send({
    id: `${child.id}:final-result`,
    senderSessionId: child.id,
    recipientSessionId: parent.id,
    createdAt: child.createdAt,
    body: {
      type: "child_result",
      result: {
        childSessionId: child.id,
        status: "completed",
        conclusion:
          conclusion?.type === "text" ? conclusion.text : "No conclusion",
        evidenceRefs: [],
        artifactRefs: [],
      },
    },
  });
}

const childRuns = Promise.all(children.map(runChild));
// Attach a rejection handler immediately; the parent awaits completion below.
void childRuns.catch(() => undefined);
let parentTurn = 0;
const parentModel = scripted(async (request) => {
  parentTurn += 1;
  if (parentTurn === 1)
    return children.map((child) => ({
      type: "tool_call" as const,
      id: `note-${child.id}`,
      name: "send_note",
      input: {
        childId: child.id,
        text: "Please investigate enterprise pricing.",
      },
    }));
  if (parentTurn === 2)
    return [
      {
        type: "tool_call",
        id: "background",
        name: "research_background",
        input: {},
      },
    ];
  const findings = request.context.messages.filter(
    (message) => message.metadata?.childSessionId !== undefined,
  );
  if (findings.length !== children.length)
    throw new Error("a child's finding was lost");
  return [
    {
      type: "text",
      text: `Compared both companies using ${findings.length} child findings and background research.`,
    },
  ];
});
const actions: ActionExecutor = {
  async execute(invocation) {
    if (invocation.call.name === "send_note") {
      const input = invocation.call.input as { childId: string; text: string };
      if (!children.some((child) => child.id === input.childId))
        throw new Error("unknown child");
      await mailbox.send({
        id: invocation.idempotencyKey!,
        senderSessionId: parent.id,
        recipientSessionId: input.childId,
        createdAt: parent.createdAt,
        body: {
          type: "message",
          content: [{ type: "text", text: input.text }],
        },
      });
    } else if (invocation.call.name === "research_background") {
      // The deterministic background operation remains in flight while the child
      // loops finish. Their findings enter the mailbox, not this active journal.
      await childRuns;
    } else throw new Error(`unknown tool: ${invocation.call.name}`);
    return {
      invocationId: invocation.invocationId,
      status: "succeeded",
      content: [{ type: "text", text: "Operation completed." }],
    };
  },
};

const outcome = await runAgentLoop({
  sessionId: parent.id,
  config,
  journal: storage.journal,
  mailbox,
  model: parentModel,
  actions,
});
await childRuns;
console.log("Parent outcome:", outcome);
console.log("Saved data:", root);
const reopened = new FileMailboxStore(join(root, "mailbox"));
console.log(
  "Pending recipients after reopening:",
  await reopened.pendingRecipients(),
);
console.log(
  "Parent deliveries:",
  (await reopened.read(parent.id)).map((record) => ({
    from: record.message.senderSessionId,
    status: record.status,
    eventId: record.delivery?.eventId,
  })),
);
