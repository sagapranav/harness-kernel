import {
  MemoryJournalStore,
  MemorySessionCatalog,
  SessionManager,
  createId,
  messageEvent,
  nowIso,
  runAgentLoop,
  type ActionExecutor,
  type ImmutableRunConfig,
  type ModelInvoker,
} from '../src/index.js';

const journal = new MemoryJournalStore();
const sessions = new SessionManager(journal, new MemorySessionCatalog());
const config: ImmutableRunConfig = {
  id: createId('config'),
  version: 1,
  createdAt: nowIso(),
  provider: { provider: 'example', model: 'deterministic-demo' },
  tools: [
    {
      name: 'lookup',
      description: 'Return one deterministic fact.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};

const session = await sessions.create(config, { purpose: 'Demonstrate the loop' });
await journal.append(
  session.id,
  messageEvent({
    id: createId('msg'),
    role: 'user',
    createdAt: nowIso(),
    content: [{ type: 'text', text: 'Look up the answer.' }],
  }),
);

let calls = 0;
const model: ModelInvoker = {
  async invoke() {
    calls += 1;
    return {
      message: {
        id: createId('msg'),
        role: 'assistant',
        createdAt: nowIso(),
        content:
          calls === 1
            ? [{ type: 'tool_call', id: 'lookup-1', name: 'lookup', input: {} }]
            : [{ type: 'text', text: 'The tool returned 42.' }],
      },
      telemetry: {
        provider: 'example',
        model: 'deterministic-demo',
        latencyMs: 0,
        stopReason: calls === 1 ? 'tool_use' : 'end',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
  },
};

const actions: ActionExecutor = {
  async execute(invocation) {
    return {
      invocationId: invocation.invocationId,
      status: 'succeeded',
      content: [{ type: 'text', text: '42' }],
    };
  },
};

console.log(await runAgentLoop({ sessionId: session.id, config, journal, model, actions }));
console.log(await sessions.project(session.id));
