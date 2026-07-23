import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryJournalStore,
  createId,
  foldProjection,
  nowIso,
  projectContext,
  runAgentLoop,
  telemetryProjection,
  type ActionExecutor,
  type ImmutableRunConfig,
  type ModelInvoker,
} from '../src/index.js';

const config: ImmutableRunConfig = {
  id: 'loop-config',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  provider: { provider: 'test', model: 'test-model' },
  tools: [
    { name: 'slow', description: 'slow', inputSchema: { type: 'object' } },
    { name: 'fast', description: 'fast', inputSchema: { type: 'object' } },
  ],
};

test('loop records completion-order receipts and source-order tool messages', async () => {
  const journal = new MemoryJournalStore();
  let modelCalls = 0;
  const seenToolOrder: string[][] = [];
  const model: ModelInvoker = {
    async invoke(request) {
      modelCalls += 1;
      seenToolOrder.push(
        request.context.messages.flatMap((message) =>
          message.content
            .filter((block) => block.type === 'tool_result')
            .map((block) => (block as { type: 'tool_result'; name?: string }).name ?? ''),
        ),
      );
      return {
        message: {
          id: createId('msg'),
          role: 'assistant',
          createdAt: nowIso(),
          content:
            modelCalls === 1
              ? [
                  { type: 'tool_call', id: 'slow-call', name: 'slow', input: {} },
                  { type: 'tool_call', id: 'fast-call', name: 'fast', input: {} },
                ]
              : [{ type: 'text', text: 'done' }],
        },
        telemetry: {
          provider: 'test',
          model: 'test-model',
          latencyMs: 5,
          stopReason: modelCalls === 1 ? 'tool_use' : 'end',
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      };
    },
  };
  const actions: ActionExecutor = {
    async execute(invocation) {
      if (invocation.call.name === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return {
        invocationId: invocation.invocationId,
        status: 'succeeded',
        content: [{ type: 'text', text: invocation.call.name }],
      };
    },
  };

  const outcome = await runAgentLoop({
    sessionId: 'loop-session',
    config,
    journal,
    model,
    actions,
  });
  assert.deepEqual(outcome, { status: 'completed', turns: 2 });
  assert.deepEqual(seenToolOrder[1], ['slow', 'fast']);

  const events = await journal.read('loop-session');
  const completionNames = events
    .filter((event) => event.type === 'action.completed')
    .map((event) => {
      const data = event.data as { invocation: { call: { name: string } } };
      return data.invocation.call.name;
    });
  assert.deepEqual(completionNames, ['fast', 'slow']);

  const context = projectContext('loop-session', events);
  const toolNames = context.messages.flatMap((message) =>
    message.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => (block as { type: 'tool_result'; name?: string }).name),
  );
  assert.deepEqual(toolNames, ['slow', 'fast']);

  const telemetry = foldProjection('loop-session', events, telemetryProjection);
  assert.equal(telemetry.state.modelCalls, 2);
  assert.equal(telemetry.state.actionCalls, 2);
  assert.equal(telemetry.state.inputTokens, 20);
});
