import {
  MemoryJournalStore,
  MemorySessionCatalog,
  SessionManager,
  createId,
  messageEvent,
  nowIso,
  type ImmutableRunConfig,
} from '../src/index.js';

const journal = new MemoryJournalStore();
const manager = new SessionManager(journal, new MemorySessionCatalog());
const config: ImmutableRunConfig = {
  id: createId('config'),
  version: 1,
  createdAt: nowIso(),
  provider: { provider: 'anthropic', model: 'your-model' },
  tools: [],
};

const parent = await manager.create(config, { purpose: 'Own the final artifact' });
await journal.append(
  parent.id,
  messageEvent({
    id: createId('msg'),
    role: 'user',
    createdAt: nowIso(),
    content: [{ type: 'text', text: 'Review this implementation.' }],
  }),
);

const child = await manager.fork(parent.id, config, {
  purpose: 'Find evidence that the implementation is wrong',
});
await journal.append(
  child.id,
  messageEvent({
    id: createId('msg'),
    role: 'assistant',
    createdAt: nowIso(),
    content: [{ type: 'text', text: 'I found no counterexample.' }],
  }),
);
await manager.completeChild(parent.id, {
  childSessionId: child.id,
  status: 'completed',
  noneFound: true,
  confidence: 0.8,
  evidenceRefs: [],
  artifactRefs: [],
});

console.log('Child context:', await manager.project(child.id));
console.log('Parent context:', await manager.project(parent.id));
