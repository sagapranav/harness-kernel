import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
} from '../src/index.js';

function textMessage(role: CanonicalMessage['role'], text: string): CanonicalMessage {
  return {
    id: createId('msg'),
    role,
    createdAt: nowIso(),
    content: [{ type: 'text', text }],
  };
}

function text(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('');
}

const config: ImmutableRunConfig = {
  id: 'config-1',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  provider: { provider: 'test', model: 'test' },
  tools: [],
};

test('compaction changes the working projection but preserves every raw event', async () => {
  const journal = new MemoryJournalStore();
  const first = await journal.append('s1', messageEvent(textMessage('user', 'first')));
  const second = await journal.append('s1', messageEvent(textMessage('assistant', 'second')));
  await journal.append(
    's1',
    compactionEvent({
      summarizesThroughEventId: second.id,
      summary: textMessage('user', 'summary of first and second'),
      evidenceRefs: [],
      scope: 'local',
      projectorVersion: 1,
    }),
  );
  await journal.append('s1', messageEvent(textMessage('assistant', 'third')));

  const raw = await journal.read('s1');
  const projected = projectContext('s1', raw);
  assert.equal(raw.length, 4);
  assert.deepEqual(projected.messages.map(text), ['summary of first and second', 'third']);
  assert.equal(first.sequence, 1);
});

test('a child inherits a parent projection but owns an independent compactable journal', async () => {
  const journal = new MemoryJournalStore();
  const manager = new SessionManager(journal, new MemorySessionCatalog());
  const parent = await manager.create(config, { id: 'parent' });
  await journal.append(parent.id, messageEvent(textMessage('user', 'parent task')));

  const child = await manager.fork(parent.id, config, { id: 'child', purpose: 'review' });
  const childObservation = await journal.append(
    child.id,
    messageEvent(textMessage('assistant', 'child research')),
  );

  const beforeCompaction = await manager.project(child.id);
  assert.deepEqual(beforeCompaction.messages.map(text), ['parent task', 'child research']);

  await journal.append(
    child.id,
    compactionEvent({
      summarizesThroughEventId: childObservation.id,
      summary: textMessage('user', 'combined child summary'),
      evidenceRefs: [],
      scope: 'including_inherited',
      projectorVersion: 1,
    }),
  );
  const afterCompaction = await manager.project(child.id);
  assert.deepEqual(afterCompaction.messages.map(text), ['combined child summary']);
  assert.equal((await journal.read(parent.id)).some((event) => event.type === 'context.compacted'), false);

  await manager.completeChild(parent.id, {
    childSessionId: child.id,
    status: 'completed',
    conclusion: 'One issue found at src/a.ts:10.',
    confidence: 0.9,
    evidenceRefs: [],
    artifactRefs: [],
  });
  const parentProjection = await manager.project(parent.id);
  assert.deepEqual(parentProjection.messages.map(text), [
    'parent task',
    'One issue found at src/a.ts:10.',
  ]);
  assert.equal((await journal.read(child.id)).length, 3);
});
