import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fromAnthropicMessage,
  fromOpenAIChatCompletion,
  fromOpenAIResponse,
  toAnthropicInput,
  toOpenAIInput,
} from '../src/index.js';

test('OpenAI Responses normalization retains tools, usage, and unknown blocks', () => {
  const normalized = fromOpenAIResponse(
    {
      id: 'resp_1',
      model: 'served-model',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'hello' },
            { type: 'future_block', payload: 1 },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"query":"logs"}',
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 10 },
      },
    },
    { model: 'requested-model', latencyMs: 50 },
  );

  assert.equal(normalized.message.id, 'resp_1');
  assert.equal(normalized.telemetry.servedModel, 'served-model');
  assert.equal(normalized.telemetry.usage.cacheReadTokens, 10);
  assert.equal(normalized.message.content.some((block) => block.type === 'provider'), true);
  assert.deepEqual(
    normalized.message.content.find((block) => block.type === 'tool_call'),
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'search',
      input: { query: 'logs' },
    },
  );
});

test('OpenAI Chat Completions normalization supports compatible endpoints', () => {
  const normalized = fromOpenAIChatCompletion(
    {
      id: 'chat_1',
      model: 'compat-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_2',
                function: { name: 'lookup', arguments: '{"id":2}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    { model: 'compat-model' },
  );
  assert.equal(normalized.telemetry.stopReason, 'tool_use');
  assert.equal(normalized.message.content[0]?.type, 'tool_call');
});

test('Anthropic normalization and outbound encoders preserve shared semantics', () => {
  const normalized = fromAnthropicMessage(
    {
      id: 'msg_1',
      model: 'served-claude',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'inspect', signature: 'sig' },
        { type: 'text', text: 'I will inspect.' },
        { type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a.ts' } },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
      },
    },
    { model: 'requested-claude' },
  );

  assert.equal(normalized.telemetry.stopReason, 'tool_use');
  assert.equal(normalized.telemetry.usage.cacheReadTokens, 80);
  assert.equal(toOpenAIInput([normalized.message]).some((item) => item.type === 'function_call'), true);
  assert.equal(toAnthropicInput([normalized.message]).messages[0]?.role, 'assistant');
});
