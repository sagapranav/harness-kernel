import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertStorageConformance,
  checkHarnessStorage,
  createMemoryStorage,
  defaultRuntime,
  fromAnthropicMessage,
  SessionManager,
  type ImmutableRunConfig,
  type RuntimeServices,
} from "../src/index.js";
import { createFileStorage } from "../src/node.js";

function deterministicRuntime(): RuntimeServices {
  let next = 0;
  return {
    createId(prefix) {
      next += 1;
      return `${prefix ?? "id"}_${next}`;
    },
    nowIso() {
      return "2026-01-01T00:00:00.000Z";
    },
    sha256(value) {
      return defaultRuntime.sha256(value);
    },
  };
}

test("memory and filesystem bundles satisfy reusable storage conformance", async () => {
  const memory = await checkHarnessStorage(
    createMemoryStorage(deterministicRuntime()),
    deterministicRuntime(),
  );
  assertStorageConformance(memory);
  assert.equal(memory.passed, true);

  const root = await mkdtemp(join(tmpdir(), "harness-storage-"));
  try {
    const files = await checkHarnessStorage(
      createFileStorage(root, deterministicRuntime()),
      deterministicRuntime(),
    );
    assertStorageConformance(files);
    assert.equal(files.passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime services control generated provider identity and time", () => {
  const runtime = deterministicRuntime();
  const normalized = fromAnthropicMessage(
    {
      content: [{ type: "tool_use", name: "search", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { model: "test", runtime },
  );
  const call = normalized.message.content.find(
    (block) => block.type === "tool_call",
  );
  assert.equal(normalized.message.id, "msg_2");
  assert.equal(call?.type === "tool_call" ? call.id : null, "call_1");
  assert.equal(normalized.message.createdAt, "2026-01-01T00:00:00.000Z");
});

test("runtime services control journal and session identity and time", async () => {
  const runtime = deterministicRuntime();
  const storage = createMemoryStorage(runtime);
  const manager = new SessionManager(
    storage.journal,
    storage.sessions,
    runtime,
  );
  const config: ImmutableRunConfig = {
    id: "config",
    version: 1,
    createdAt: runtime.nowIso(),
    provider: { provider: "test", model: "test" },
    tools: [],
  };
  const session = await manager.create(config);
  const started = (await storage.journal.read(session.id))[0]!;

  assert.equal(session.id, "session_1");
  assert.equal(session.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(started.id, "evt_2");
  assert.equal(started.timestamp, "2026-01-01T00:00:00.000Z");
});

test("portable root dependency graph contains no Node built-ins", async () => {
  const root = resolve("dist/src/index.js");
  const visited = new Set<string>();

  const inspect = async (path: string): Promise<void> => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = await readFile(path, "utf8");
    const specifiers = [
      ...source.matchAll(
        /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      assert.equal(
        specifier.startsWith("node:"),
        false,
        `${path} imports ${specifier}`,
      );
      if (!specifier.startsWith(".")) continue;
      await inspect(resolve(dirname(path), specifier));
    }
  };

  await inspect(root);
  assert.ok(visited.size >= 10);
});
