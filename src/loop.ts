import { createId, nowIso } from './ids.js';
import type { JournalStore } from './journal.js';
import { EVENT_TYPES, messageEvent, projectContext } from './projection.js';
import type {
  ActionInvocation,
  ActionReceipt,
  CanonicalMessage,
  ContextProjection,
  ImmutableRunConfig,
  LoopOutcome,
  NormalizedModelResponse,
  ToolCallBlock,
} from './protocol.js';

export interface ModelRequest {
  sessionId: string;
  turnId: string;
  config: ImmutableRunConfig;
  context: ContextProjection;
}

export interface ModelInvoker {
  invoke(request: ModelRequest, signal?: AbortSignal): Promise<NormalizedModelResponse>;
}

export interface ActionExecutor {
  execute(invocation: ActionInvocation, signal?: AbortSignal): Promise<ActionReceipt>;
}

export interface AgentLoopOptions {
  sessionId: string;
  config: ImmutableRunConfig;
  journal: JournalStore;
  model: ModelInvoker;
  actions: ActionExecutor;
  signal?: AbortSignal;
  maxTurns?: number;
  /**
   * Override context construction for retrieval, inherited child context, or
   * application-specific projections.
   */
  project?: () => Promise<ContextProjection>;
}

function toolCalls(message: CanonicalMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === 'tool_call');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendOutcome(
  options: AgentLoopOptions,
  outcome: LoopOutcome,
): Promise<LoopOutcome> {
  await options.journal.append(options.sessionId, {
    category: 'control',
    type: EVENT_TYPES.runCompleted,
    data: { outcome },
  });
  return outcome;
}

async function executeOne(
  options: AgentLoopOptions,
  turnId: string,
  call: ToolCallBlock,
): Promise<ActionReceipt> {
  const invocation: ActionInvocation = {
    invocationId: createId('invocation'),
    sessionId: options.sessionId,
    turnId,
    call,
    idempotencyKey: `${options.sessionId}:${call.id}`,
  };
  await options.journal.append(options.sessionId, {
    category: 'trace',
    type: EVENT_TYPES.actionStarted,
    turnId,
    data: { invocation },
  });

  let receipt: ActionReceipt;
  try {
    receipt = await options.actions.execute(invocation, options.signal);
  } catch (error) {
    receipt = {
      invocationId: invocation.invocationId,
      status: 'failed',
      content: [{ type: 'text', text: errorText(error) }],
      metadata: { thrown: true },
    };
  }

  await options.journal.append(options.sessionId, {
    category: 'trace',
    type: EVENT_TYPES.actionCompleted,
    turnId,
    data: { invocation, receipt },
  });
  return receipt;
}

/**
 * Minimal provider-neutral loop.
 *
 * - The model and action surface are injected.
 * - Every observation is appended before it can affect the next call.
 * - Action completion traces may be in completion order.
 * - Tool-result context messages are appended in source-call order.
 * - Provider and action failures become events and outcomes.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<LoopOutcome> {
  const limit = options.maxTurns ?? 100;
  let turns = 0;

  while (turns < limit) {
    if (options.signal?.aborted === true) {
      return appendOutcome(options, { status: 'cancelled', turns });
    }

    turns += 1;
    const turnId = createId('turn');
    const context =
      options.project === undefined
        ? projectContext(options.sessionId, await options.journal.read(options.sessionId))
        : await options.project();

    await options.journal.append(options.sessionId, {
      category: 'trace',
      type: EVENT_TYPES.modelCallStarted,
      turnId,
      data: {
        configId: options.config.id,
        configVersion: options.config.version,
        provider: options.config.provider,
        contextThroughEventId: context.rawThroughEventId,
      },
    });

    let response: NormalizedModelResponse;
    try {
      response = await options.model.invoke(
        { sessionId: options.sessionId, turnId, config: options.config, context },
        options.signal,
      );
    } catch (error) {
      const message = errorText(error);
      await options.journal.append(options.sessionId, {
        category: 'trace',
        type: EVENT_TYPES.modelCallCompleted,
        turnId,
        data: {
          error: message,
          telemetry: {
            provider: options.config.provider.provider,
            model: options.config.provider.model,
            latencyMs: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'error',
          },
        },
      });
      return appendOutcome(options, { status: 'failed', turns, error: message });
    }

    await options.journal.append(options.sessionId, {
      category: 'trace',
      type: EVENT_TYPES.modelCallCompleted,
      turnId,
      data: { telemetry: response.telemetry },
    });
    await options.journal.append(options.sessionId, messageEvent(response.message, turnId));

    const calls = toolCalls(response.message);
    if (calls.length === 0) {
      if (response.telemetry.stopReason === 'error') {
        return appendOutcome(options, {
          status: 'failed',
          turns,
          error: 'provider returned an error termination',
        });
      }
      if (response.telemetry.stopReason === 'aborted') {
        return appendOutcome(options, { status: 'cancelled', turns });
      }
      if (response.telemetry.stopReason === 'length') {
        return appendOutcome(options, {
          status: 'checkpointed',
          turns,
          reason: 'model output limit reached',
        });
      }
      return appendOutcome(options, { status: 'completed', turns });
    }

    const receipts = await Promise.all(calls.map((call) => executeOne(options, turnId, call)));
    for (const [index, call] of calls.entries()) {
      const receipt = receipts[index]!;
      const resultMessage: CanonicalMessage = {
        id: createId('msg'),
        role: 'tool',
        createdAt: nowIso(),
        content: [
          {
            type: 'tool_result',
            toolCallId: call.id,
            name: call.name,
            isError: receipt.status !== 'succeeded',
            content: receipt.content,
          },
        ],
        metadata: {
          invocationId: receipt.invocationId,
          status: receipt.status,
          evidenceRefs: receipt.evidenceRefs ?? [],
        },
      };
      await options.journal.append(options.sessionId, messageEvent(resultMessage, turnId));
    }

    if (receipts.some((receipt) => receipt.status === 'pending' || receipt.status === 'unknown')) {
      return appendOutcome(options, {
        status: 'checkpointed',
        turns,
        reason: 'an action requires postcondition reconciliation',
      });
    }
  }

  return appendOutcome(options, { status: 'limited', turns, limit });
}
