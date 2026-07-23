import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  foldProjection,
  MemoryJournalStore,
  MemorySessionCatalog,
  SessionManager,
  compactionEvent,
  createId,
  messageEvent,
  nowIso,
  projectContext,
  type CanonicalMessage,
  type ImmutableRunConfig,
} from "../src/index.js";
import { FileProjectionStore, FileSessionCatalog } from "../src/node.js";

function textMessage(
  role: CanonicalMessage["role"],
  text: string,
): CanonicalMessage {
  return {
    id: createId("msg"),
    role,
    createdAt: nowIso(),
    content: [{ type: "text", text }],
  };
}

function text(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");
}

const config: ImmutableRunConfig = {
  id: "config-1",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  provider: { provider: "test", model: "test" },
  tools: [],
};

test("compaction changes the working projection but preserves every raw event", async () => {
  const journal = new MemoryJournalStore();
  const first = await journal.append(
    "s1",
    messageEvent(textMessage("user", "first")),
  );
  const second = await journal.append(
    "s1",
    messageEvent(textMessage("assistant", "second")),
  );
  await journal.append(
    "s1",
    compactionEvent({
      summarizesThroughEventId: second.id,
      summary: textMessage("user", "summary of first and second"),
      evidenceRefs: [],
      scope: "local",
      projectorVersion: 1,
    }),
  );
  await journal.append("s1", messageEvent(textMessage("assistant", "third")));

  const raw = await journal.read("s1");
  const projected = projectContext("s1", raw);
  assert.equal(raw.length, 4);
  assert.deepEqual(projected.messages.map(text), [
    "summary of first and second",
    "third",
  ]);
  assert.equal(first.sequence, 1);
});

test("an invalid newer compaction cannot hide an earlier valid projection", async () => {
  const journal = new MemoryJournalStore();
  const boundary = await journal.append(
    "fallback",
    messageEvent(textMessage("user", "old")),
  );
  await journal.append(
    "fallback",
    compactionEvent({
      summarizesThroughEventId: boundary.id,
      summary: textMessage("user", "valid summary"),
      evidenceRefs: [],
      scope: "local",
      projectorVersion: 1,
    }),
  );
  await journal.append("fallback", {
    category: "context",
    type: "context.compacted",
    affectsContext: true,
    data: {
      summarizesThroughEventId: "missing",
      summary: textMessage("user", "invalid summary"),
      evidenceRefs: [],
      scope: "local",
      projectorVersion: 1,
    },
  });

  assert.deepEqual(
    projectContext("fallback", await journal.read("fallback")).messages.map(
      text,
    ),
    ["valid summary"],
  );
});

test("incremental cold projections match full rebuilds without mutating prior snapshots", async () => {
  const journal = new MemoryJournalStore();
  await journal.append("projection", {
    category: "trace",
    type: "number",
    data: { value: 1 },
  });
  const definition = {
    name: "sum",
    version: 1,
    initial: () => ({ total: 0 }),
    reduce: (state: { total: number }, event: { data: unknown }) => {
      const data = event.data as { value?: number };
      state.total += data.value ?? 0;
      return state;
    },
  };
  const first = foldProjection(
    "projection",
    await journal.read("projection"),
    definition,
  );
  await journal.append("projection", {
    category: "trace",
    type: "number",
    data: { value: 2 },
  });
  const incremental = foldProjection(
    "projection",
    await journal.read("projection", {
      afterSequence: first.throughSequence,
    }),
    definition,
    first,
  );
  const journalEvents = await journal.read("projection");
  const rebuilt = foldProjection("projection", journalEvents, definition);

  assert.equal(first.state.total, 1);
  assert.equal(incremental.state.total, 3);
  assert.deepEqual(incremental, rebuilt);
  assert.throws(
    () =>
      foldProjection("projection", journalEvents, definition, {
        ...first,
        throughEventId: "forged",
      }),
    /does not match the raw journal/,
  );
});

test("a child inherits a parent projection but owns an independent compactable journal", async () => {
  const journal = new MemoryJournalStore();
  const manager = new SessionManager(journal, new MemorySessionCatalog());
  const parent = await manager.create(config, { id: "parent" });
  await journal.append(
    parent.id,
    messageEvent(textMessage("user", "parent task")),
  );

  const child = await manager.fork(parent.id, config, {
    id: "child",
    purpose: "review",
  });
  const childObservation = await journal.append(
    child.id,
    messageEvent(textMessage("assistant", "child research")),
  );

  const beforeCompaction = await manager.project(child.id);
  assert.deepEqual(beforeCompaction.messages.map(text), [
    "parent task",
    "child research",
  ]);

  await journal.append(
    child.id,
    compactionEvent({
      summarizesThroughEventId: childObservation.id,
      summary: textMessage("user", "combined child summary"),
      evidenceRefs: [],
      scope: "including_inherited",
      projectorVersion: 1,
    }),
  );
  const afterCompaction = await manager.project(child.id);
  assert.deepEqual(afterCompaction.messages.map(text), [
    "combined child summary",
  ]);
  assert.equal(
    (await journal.read(parent.id)).some(
      (event) => event.type === "context.compacted",
    ),
    false,
  );

  await manager.completeChild(parent.id, {
    childSessionId: child.id,
    status: "completed",
    conclusion: "One issue found at src/a.ts:10.",
    confidence: 0.9,
    evidenceRefs: [],
    artifactRefs: [],
  });
  const parentProjection = await manager.project(parent.id);
  assert.deepEqual(parentProjection.messages.map(text), [
    "parent task",
    "One issue found at src/a.ts:10.",
  ]);
  assert.equal((await journal.read(child.id)).length, 3);
});

test("child completion is idempotent and conflicting completion fails", async () => {
  const journal = new MemoryJournalStore();
  const manager = new SessionManager(journal, new MemorySessionCatalog());
  const parent = await manager.create(config, { id: "idempotent-parent" });
  const child = await manager.fork(parent.id, config, {
    id: "idempotent-child",
  });
  const result = {
    childSessionId: child.id,
    status: "completed" as const,
    conclusion: "checked",
    evidenceRefs: [],
    artifactRefs: [],
  };

  await manager.completeChild(parent.id, result);
  await manager.completeChild(parent.id, result);
  assert.equal(
    (await journal.read(parent.id)).filter(
      (event) => event.type === "child.completed",
    ).length,
    1,
  );
  await assert.rejects(
    manager.completeChild(parent.id, { ...result, conclusion: "different" }),
    /completion conflict/,
  );
  await assert.rejects(
    manager.completeChild(parent.id, { ...result, confidence: 1.1 }),
    /between 0 and 1/,
  );
});

test("file session catalog never overwrites immutable configs", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-catalog-"));
  try {
    const catalog = new FileSessionCatalog(root);
    await catalog.putConfig(config);
    await catalog.putConfig(config);
    await assert.rejects(
      catalog.putConfig({
        ...config,
        provider: { provider: "test", model: "different" },
      }),
      /immutable config conflict/,
    );
    assert.deepEqual(await catalog.getConfig(config.id), config);
    await catalog.putSession({
      id: "..",
      configId: config.id,
      createdAt: config.createdAt,
    });
    assert.equal((await catalog.getSession(".."))?.id, "..");
    await assert.rejects(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(root, "session.json")),
      ),
      { code: "ENOENT" },
    );

    const projections = new FileProjectionStore(join(root, "projections"));
    const snapshot = {
      name: "..",
      version: 1,
      sessionId: "..",
      throughSequence: 0,
      throughEventId: null,
      state: { total: 0 },
    };
    await projections.save(snapshot);
    assert.deepEqual(await projections.load("..", "..", 1), snapshot);
    await assert.rejects(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(root, "sum-v1.json")),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
