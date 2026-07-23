import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FileArtifactStore,
  JournalConflictError,
  JsonlJournalStore,
  MemoryArtifactStore,
  MemoryJournalStore,
} from '../src/index.js';

test('memory journal creates a linear causal chain and enforces expected heads', async () => {
  const store = new MemoryJournalStore();
  const first = await store.append(
    'session-1',
    { category: 'control', type: 'test.first', data: { value: 1 } },
    { expectedHeadId: null },
  );
  const second = await store.append(
    'session-1',
    { category: 'trace', type: 'test.second', data: { value: 2 } },
    { expectedHeadId: first.id },
  );

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.parentId, first.id);
  await assert.rejects(
    store.append(
      'session-1',
      { category: 'trace', type: 'test.conflict', data: {} },
      { expectedHeadId: first.id },
    ),
    JournalConflictError,
  );
});

test('jsonl journal persists unknown events without rewriting earlier bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-journal-'));
  try {
    const store = new JsonlJournalStore(root);
    await store.append('session/with spaces', {
      category: 'trace',
      type: 'future.vendor.event',
      version: 99,
      data: { arbitrary: ['shape', 42] },
    });
    const eventPath = join(root, encodeURIComponent('session/with spaces'), 'events.jsonl');
    const before = await readFile(eventPath, 'utf8');
    await store.append('session/with spaces', {
      category: 'control',
      type: 'another.event',
      data: {},
    });
    const after = await readFile(eventPath, 'utf8');

    assert.ok(after.startsWith(before));
    const events = await store.read('session/with spaces');
    assert.equal(events[0]?.type, 'future.vendor.event');
    assert.deepEqual(events[0]?.data, { arbitrary: ['shape', 42] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jsonl journal linearizes concurrent appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-concurrency-'));
  try {
    const store = new JsonlJournalStore(root);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append('concurrent', {
          category: 'trace',
          type: 'concurrent.event',
          data: { index },
        }),
      ),
    );
    const events = await store.read('concurrent');
    assert.equal(events.length, 20);
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact stores are content addressed and idempotent', async () => {
  const memory = new MemoryArtifactStore();
  const one = await memory.put('same bytes', { mediaType: 'text/plain' });
  const two = await memory.put('same bytes', { mediaType: 'text/plain' });
  assert.equal(one.sha256, two.sha256);
  assert.equal(new TextDecoder().decode(await memory.get(one)), 'same bytes');

  const root = await mkdtemp(join(tmpdir(), 'harness-artifacts-'));
  try {
    const files = new FileArtifactStore(root);
    const fileRef = await files.put('same bytes', { mediaType: 'text/plain' });
    assert.equal(fileRef.sha256, one.sha256);
    assert.equal(await files.has(fileRef), true);
    assert.equal(new TextDecoder().decode(await files.get(fileRef)), 'same bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
