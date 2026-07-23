import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  createId,
  createMemoryStorage,
  messageEvent,
  nowIso,
  type ImmutableRunConfig,
} from "../src/index.js";
import { collectSessionBundle, renderSessionViewer } from "../src/node.js";

function extractBundle(html: string): {
  rootSessionId: string;
  sessions: Record<string, unknown>;
  images: Record<string, string>;
} {
  const match = html.match(
    /<script type="application\/json" id="viewer-data">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, "embedded viewer data present");
  return JSON.parse(match![1]!.replace(/\\u003c/g, "<"));
}

test("viewer bundle captures a parent, its sub-agent, config, and image", async () => {
  const storage = createMemoryStorage();
  const sessions = new SessionManager(storage.journal, storage.sessions);

  const parentConfig: ImmutableRunConfig = {
    id: "parent-config",
    version: 1,
    createdAt: nowIso(),
    provider: { provider: "anthropic", model: "manager" },
    systemPrompt: "You are the manager. Delegate and summarize.",
    tools: [
      {
        name: "spawn",
        description: "Spawn a child.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
  const childConfig: ImmutableRunConfig = {
    id: "child-config",
    version: 1,
    createdAt: nowIso(),
    provider: { provider: "openai", model: "worker" },
    tools: [],
  };

  const parent = await sessions.create(parentConfig, { purpose: "Root task" });
  await storage.journal.append(
    parent.id,
    messageEvent({
      id: createId("msg"),
      role: "user",
      createdAt: nowIso(),
      content: [{ type: "text", text: "Investigate the target." }],
    }),
  );

  // Fork a child without the parent-side child.started (spawn-as-a-tool
  // pattern); the viewer must still discover it via child.completed.
  const child = await sessions.fork(parent.id, childConfig, {
    id: "child-1",
    purpose: "Collect evidence",
    linkInParent: false,
  });
  const ref = await storage.artifacts.put(new Uint8Array([137, 80, 78, 71]), {
    mediaType: "image/png",
  });
  await storage.journal.append(
    child.id,
    messageEvent({
      id: createId("msg"),
      role: "tool",
      createdAt: nowIso(),
      content: [
        {
          type: "tool_result",
          toolCallId: "shot-1",
          isError: false,
          content: [{ type: "image", artifact: ref }],
        },
      ],
    }),
  );
  await sessions.completeChild(parent.id, {
    childSessionId: child.id,
    status: "completed",
    conclusion: "Found the marker.",
    confidence: 0.9,
    evidenceRefs: [],
    artifactRefs: [],
  });

  const bundle = await collectSessionBundle(storage, parent.id);
  assert.deepEqual(
    Object.keys(bundle.sessions).sort(),
    ["child-1", parent.id].sort(),
  );
  assert.equal(bundle.sessions[parent.id]!.childIds[0], "child-1");
  assert.equal(bundle.sessions["child-1"]!.config?.provider.model, "worker");
  assert.equal(
    bundle.sessions[parent.id]!.config?.systemPrompt,
    "You are the manager. Delegate and summarize.",
  );
  assert.equal(Object.keys(bundle.images).length, 1);
  assert.ok(bundle.images[ref.sha256]!.startsWith("data:image/png;base64,"));

  const html = await renderSessionViewer(storage, parent.id, {
    title: "Viewer test",
  });
  assert.match(html, /<title>Viewer test<\/title>/);
  assert.match(html, /id="viewer-data"/);
  const embedded = extractBundle(html);
  assert.equal(embedded.rootSessionId, parent.id);
  assert.equal(Object.keys(embedded.sessions).length, 2);
  assert.equal(Object.keys(embedded.images).length, 1);
  // The embedded JSON must not contain a raw "</script>" close.
  assert.equal(html.includes("</script"), true);
  assert.equal(
    /<script type="application\/json"[^>]*>[\s\S]*?<\/script>/.test(html),
    true,
  );
});

test("viewer can omit children and images", async () => {
  const storage = createMemoryStorage();
  const sessions = new SessionManager(storage.journal, storage.sessions);
  const config: ImmutableRunConfig = {
    id: "solo",
    version: 1,
    createdAt: nowIso(),
    provider: { provider: "openai", model: "m" },
    tools: [],
  };
  const session = await sessions.create(config, { purpose: "solo" });
  await sessions.fork(session.id, config, { id: "kid", linkInParent: false });
  await sessions.completeChild(session.id, {
    childSessionId: "kid",
    status: "completed",
    evidenceRefs: [],
    artifactRefs: [],
  });

  const bundle = await collectSessionBundle(storage, session.id, {
    includeChildren: false,
    inlineImages: false,
  });
  assert.deepEqual(Object.keys(bundle.sessions), [session.id]);
  assert.equal(Object.keys(bundle.images).length, 0);
});
