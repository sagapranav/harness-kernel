import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  ArtifactIntegrityError,
  FileArtifactStore,
  JournalConflictError,
  JsonlJournalStore,
  MemoryArtifactStore,
  MemoryJournalStore,
} from "../src/index.js";

test("memory journal creates a linear causal chain and enforces expected heads", async () => {
  const store = new MemoryJournalStore();
  const first = await store.append(
    "session-1",
    { category: "control", type: "test.first", data: { value: 1 } },
    { expectedHeadId: null },
  );
  const second = await store.append(
    "session-1",
    { category: "trace", type: "test.second", data: { value: 2 } },
    { expectedHeadId: first.id },
  );

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.parentId, first.id);
  await assert.rejects(
    store.append(
      "session-1",
      { category: "trace", type: "test.conflict", data: {} },
      { expectedHeadId: first.id },
    ),
    JournalConflictError,
  );
});

test("memory journal defensively clones inputs and outputs", async () => {
  const store = new MemoryJournalStore();
  const input = { nested: { value: 1 } };
  const appended = await store.append("immutable", {
    category: "trace",
    type: "immutable.event",
    data: input,
  });
  input.nested.value = 2;
  (appended.data as typeof input).nested.value = 3;
  const read = await store.read("immutable");
  (read[0]!.data as typeof input).nested.value = 4;

  assert.deepEqual((await store.head("immutable"))?.data, {
    nested: { value: 1 },
  });
});

test("journals reject values that cannot round-trip through JSON", async () => {
  const store = new MemoryJournalStore();
  await assert.rejects(
    store.append("invalid", {
      category: "trace",
      type: "invalid.undefined",
      data: { value: undefined },
    }),
    /not JSON-serializable/,
  );
  await assert.rejects(
    store.append("invalid", {
      category: "trace",
      type: "invalid.number",
      data: { value: Number.NaN },
    }),
    /non-finite/,
  );
  const sparse = new Array(1);
  await assert.rejects(
    store.append("invalid", {
      category: "trace",
      type: "invalid.sparse",
      data: { value: sparse },
    }),
    /must not contain holes/,
  );
  await assert.rejects(
    store.append("invalid", {
      category: "trace",
      type: "invalid.negative-zero",
      data: { value: -0 },
    }),
    /negative zero/,
  );
  await assert.rejects(
    store.append("invalid", {
      category: "trace",
      type: "invalid.symbol-key",
      data: { value: { [Symbol("hidden")]: true } },
    }),
    /symbol keys/,
  );
  await assert.rejects(
    store.append("invalid", {
      category: "invented" as never,
      type: "invalid.envelope",
      data: {},
    }),
    /invalid category/,
  );
});

test("jsonl journal persists unknown events without rewriting earlier bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-journal-"));
  try {
    const store = new JsonlJournalStore(root);
    await store.append("session/with spaces", {
      category: "trace",
      type: "future.vendor.event",
      version: 99,
      data: { arbitrary: ["shape", 42] },
    });
    const eventPath = join(
      root,
      createHash("sha256").update("session/with spaces", "utf8").digest("hex"),
      "events.jsonl",
    );
    const before = await readFile(eventPath, "utf8");
    await store.append("session/with spaces", {
      category: "control",
      type: "another.event",
      data: {},
    });
    const after = await readFile(eventPath, "utf8");

    assert.ok(after.startsWith(before));
    const events = await store.read("session/with spaces");
    assert.equal(events[0]?.type, "future.vendor.event");
    assert.deepEqual(events[0]?.data, { arbitrary: ["shape", 42] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl journal linearizes concurrent appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-concurrency-"));
  try {
    const store = new JsonlJournalStore(root);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append("concurrent", {
          category: "trace",
          type: "concurrent.event",
          data: { index },
        }),
      ),
    );
    const events = await store.read("concurrent");
    assert.equal(events.length, 20);
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("async stores snapshot mutable inputs before yielding", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-snapshot-"));
  try {
    const journal = new JsonlJournalStore(root);
    const data = { nested: { value: 1 } };
    const append = journal.append("snapshot", {
      category: "trace",
      type: "snapshot.event",
      data,
    });
    data.nested.value = 2;
    await append;
    assert.deepEqual((await journal.read("snapshot"))[0]?.data, {
      nested: { value: 1 },
    });

    const artifacts = new FileArtifactStore(join(root, "artifacts"));
    const mutableBytes = new Uint8Array([1, 2, 3]);
    const put = artifacts.put(mutableBytes);
    mutableBytes[0] = 9;
    const ref = await put;
    assert.deepEqual([...(await artifacts.get(ref))], [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact stores are content addressed and idempotent", async () => {
  const memory = new MemoryArtifactStore();
  const one = await memory.put("same bytes", { mediaType: "text/plain" });
  const two = await memory.put("same bytes", { mediaType: "text/plain" });
  assert.equal(one.sha256, two.sha256);
  assert.equal(new TextDecoder().decode(await memory.get(one)), "same bytes");
  await assert.rejects(
    memory.get({ ...one, bytes: one.bytes + 1 }),
    ArtifactIntegrityError,
  );

  const root = await mkdtemp(join(tmpdir(), "harness-artifacts-"));
  try {
    const files = new FileArtifactStore(root);
    const fileRef = await files.put("same bytes", { mediaType: "text/plain" });
    assert.equal(fileRef.sha256, one.sha256);
    assert.equal(await files.has(fileRef), true);
    assert.equal(
      new TextDecoder().decode(await files.get(fileRef)),
      "same bytes",
    );
    const path = join(root, fileRef.sha256.slice(0, 2), fileRef.sha256);
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, "corrupted"),
    );
    await assert.rejects(files.get(fileRef), ArtifactIntegrityError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem journal identifiers cannot traverse the storage root", async () => {
  const base = await mkdtemp(join(tmpdir(), "harness-paths-"));
  const root = join(base, "store");
  try {
    const store = new JsonlJournalStore(root);
    await store.append("..", {
      category: "trace",
      type: "safe.path",
      data: {},
    });
    assert.equal((await store.read("..")).length, 1);
    await assert.rejects(readFile(join(base, "events.jsonl")), {
      code: "ENOENT",
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("artifact stores reject forged content-addressed paths", async () => {
  const store = new FileArtifactStore("/private/tmp/unused-artifact-store");
  await assert.rejects(
    store.get({
      sha256: "../../escape",
      uri: "sha256:../../escape",
      bytes: 1,
      mediaType: "text/plain",
    }),
    /64 lowercase hexadecimal/,
  );
});
