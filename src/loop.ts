import { createId, nowIso } from "./ids.js";
import { assertArtifactRef } from "./artifacts.js";
import { assertJsonSerializable } from "./json.js";
import type { JournalStore } from "./journal.js";
import { EVENT_TYPES, messageEvent, projectContext } from "./projection.js";
import type {
  ActionInvocation,
  ActionReceipt,
  CanonicalMessage,
  ContextProjection,
  ImmutableRunConfig,
  JournalEvent,
  LoopOutcome,
  NormalizedModelResponse,
  ToolCallBlock,
} from "./protocol.js";

export interface ModelRequest {
  sessionId: string;
  turnId: string;
  config: ImmutableRunConfig;
  context: ContextProjection;
}

export interface ModelInvoker {
  invoke(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<NormalizedModelResponse>;
}

export interface ActionExecutor {
  execute(
    invocation: ActionInvocation,
    signal?: AbortSignal,
  ): Promise<ActionReceipt>;
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
  return (Array.isArray(message.content) ? message.content : []).filter(
    (block): block is ToolCallBlock =>
      typeof block === "object" && block !== null && block.type === "tool_call",
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventRecord(event: JournalEvent): Record<string, unknown> {
  return typeof event.data === "object" &&
    event.data !== null &&
    !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : {};
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function artifactError(value: unknown): string | null {
  try {
    assertArtifactRef(value as Parameters<typeof assertArtifactRef>[0]);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

function contentProtocolError(
  value: unknown,
  path = "message.content",
): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  for (const [index, candidate] of value.entries()) {
    const block = record(candidate);
    if (block === null) return `${path}[${index}] must be an object`;
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string")
          return `${path}[${index}].text must be a string`;
        break;
      case "image":
      case "file": {
        const issue = artifactError(block.artifact);
        if (issue !== null)
          return `${path}[${index}].artifact is invalid: ${issue}`;
        if (
          block.type === "image" &&
          block.alt !== undefined &&
          typeof block.alt !== "string"
        ) {
          return `${path}[${index}].alt must be a string`;
        }
        break;
      }
      case "tool_call":
        if (typeof block.id !== "string" || block.id.length === 0)
          return `${path}[${index}].id must be a non-empty string`;
        if (typeof block.name !== "string" || block.name.length === 0)
          return `${path}[${index}].name must be a non-empty string`;
        if (
          block.inputParseError !== undefined &&
          typeof block.inputParseError !== "string"
        ) {
          return `${path}[${index}].inputParseError must be a string`;
        }
        break;
      case "tool_result": {
        if (
          typeof block.toolCallId !== "string" ||
          block.toolCallId.length === 0
        ) {
          return `${path}[${index}].toolCallId must be a non-empty string`;
        }
        if (block.name !== undefined && typeof block.name !== "string")
          return `${path}[${index}].name must be a string`;
        if (typeof block.isError !== "boolean")
          return `${path}[${index}].isError must be a boolean`;
        const nested = contentProtocolError(
          block.content,
          `${path}[${index}].content`,
        );
        if (nested !== null) return nested;
        break;
      }
      case "reasoning":
        if (block.text !== undefined && typeof block.text !== "string")
          return `${path}[${index}].text must be a string`;
        if (block.redacted !== undefined && typeof block.redacted !== "boolean")
          return `${path}[${index}].redacted must be a boolean`;
        if (
          block.signature !== undefined &&
          typeof block.signature !== "string"
        )
          return `${path}[${index}].signature must be a string`;
        break;
      case "provider":
        if (typeof block.provider !== "string" || block.provider.length === 0)
          return `${path}[${index}].provider must be a non-empty string`;
        if (
          typeof block.providerType !== "string" ||
          block.providerType.length === 0
        ) {
          return `${path}[${index}].providerType must be a non-empty string`;
        }
        if (
          block.placement !== undefined &&
          block.placement !== "content" &&
          block.placement !== "item"
        ) {
          return `${path}[${index}].placement is invalid`;
        }
        if (block.rawArtifact !== undefined) {
          const issue = artifactError(block.rawArtifact);
          if (issue !== null)
            return `${path}[${index}].rawArtifact is invalid: ${issue}`;
        }
        if (block.raw === undefined && block.rawArtifact === undefined) {
          return `${path}[${index}] must retain raw data or an artifact`;
        }
        break;
      default:
        return `${path}[${index}] has unknown block type ${String(block.type)}`;
    }
  }
  return null;
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export interface ActionStateInspection {
  unstartedCalls: ToolCallBlock[];
  unresolved: Array<{ invocation: ActionInvocation; receipt?: ActionReceipt }>;
  missingResults: Array<{
    invocation: ActionInvocation;
    receipt: ActionReceipt;
  }>;
}

/**
 * Finds crash-boundary states that must be reconciled before another model
 * call. The raw journal, not the compacted context, is inspected.
 */
export function inspectActionState(
  events: JournalEvent[],
): ActionStateInspection {
  const calls = new Map<string, ToolCallBlock>();
  const starts = new Map<string, ActionInvocation>();
  const receipts = new Map<string, ActionReceipt>();
  const resultCallIds = new Set<string>();
  const resultInvocationStatuses = new Map<string, unknown>();

  for (const event of events) {
    const data = eventRecord(event);
    if (event.type === EVENT_TYPES.messageAppended) {
      const message =
        typeof data.message === "object" && data.message !== null
          ? (data.message as CanonicalMessage)
          : null;
      if (message !== null && Array.isArray(message.content)) {
        for (const candidate of message.content) {
          const block = record(candidate);
          if (
            block?.type === "tool_call" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            calls.set(block.id, block as unknown as ToolCallBlock);
          }
          if (
            block?.type === "tool_result" &&
            typeof block.toolCallId === "string"
          ) {
            resultCallIds.add(block.toolCallId);
          }
        }
        const invocationId = message.metadata?.invocationId;
        if (typeof invocationId === "string") {
          resultInvocationStatuses.set(invocationId, message.metadata?.status);
        }
      }
    } else if (event.type === EVENT_TYPES.actionStarted) {
      const invocation = data.invocation as ActionInvocation | undefined;
      if (invocation?.invocationId !== undefined)
        starts.set(invocation.invocationId, invocation);
    } else if (event.type === EVENT_TYPES.actionCompleted) {
      const invocation = data.invocation as ActionInvocation | undefined;
      const receipt = data.receipt as ActionReceipt | undefined;
      if (invocation?.invocationId !== undefined)
        starts.set(invocation.invocationId, invocation);
      if (receipt?.invocationId !== undefined)
        receipts.set(receipt.invocationId, receipt);
    }
  }

  const startedCallIds = new Set(
    [...starts.values()].map((invocation) => invocation.call.id),
  );
  const unstartedCalls = [...calls.values()].filter(
    (call) => !startedCallIds.has(call.id) && !resultCallIds.has(call.id),
  );
  const unresolved: ActionStateInspection["unresolved"] = [];
  const missingResults: ActionStateInspection["missingResults"] = [];
  for (const invocation of starts.values()) {
    const receipt = receipts.get(invocation.invocationId);
    if (
      receipt === undefined ||
      receipt.status === "pending" ||
      receipt.status === "unknown"
    ) {
      unresolved.push({
        invocation,
        ...(receipt === undefined ? {} : { receipt }),
      });
    } else {
      const projectedStatus = resultInvocationStatuses.get(
        invocation.invocationId,
      );
      const hasMatchingProjection =
        projectedStatus === receipt.status ||
        (projectedStatus === undefined &&
          resultCallIds.has(invocation.call.id));
      if (!hasMatchingProjection) missingResults.push({ invocation, receipt });
    }
  }
  return { unstartedCalls, unresolved, missingResults };
}

function modelProtocolError(response: NormalizedModelResponse): string | null {
  try {
    assertJsonSerializable(response);
  } catch (error) {
    return `model response is not durable JSON: ${errorText(error)}`;
  }
  const root = record(response);
  if (root === null) return "model response must be an object";
  const message = record(root.message);
  if (message === null) return "model response message must be an object";
  if (typeof message.id !== "string" || message.id.length === 0)
    return "model response message id must be a non-empty string";
  if (message.role !== "assistant")
    return "model response must use assistant role";
  if (
    typeof message.createdAt !== "string" ||
    Number.isNaN(Date.parse(message.createdAt))
  ) {
    return "model response createdAt must be an ISO-compatible timestamp";
  }
  if (message.provider !== undefined && typeof message.provider !== "string")
    return "model response provider must be a string";
  const contentError = contentProtocolError(message.content);
  if (contentError !== null) return contentError;

  const ids = new Set<string>();
  for (const call of toolCalls(response.message)) {
    if (ids.has(call.id)) return `duplicate tool call id: ${call.id}`;
    if (call.inputParseError !== undefined) {
      return `tool call ${call.id} has invalid JSON arguments: ${call.inputParseError}`;
    }
    ids.add(call.id);
  }

  const telemetry = record(root.telemetry);
  if (telemetry === null) return "model telemetry must be an object";
  if (typeof telemetry.provider !== "string" || telemetry.provider.length === 0)
    return "model telemetry provider must be a non-empty string";
  if (typeof telemetry.model !== "string" || telemetry.model.length === 0)
    return "model telemetry model must be a non-empty string";
  if (!nonNegativeNumber(telemetry.latencyMs))
    return "model telemetry latencyMs must be a non-negative finite number";
  const allowedStops = [
    "end",
    "tool_use",
    "length",
    "content_filter",
    "pause",
    "error",
    "aborted",
    "unknown",
  ];
  if (!allowedStops.includes(String(telemetry.stopReason)))
    return "model telemetry stopReason is invalid";
  const usage = record(telemetry.usage);
  if (usage === null) return "model telemetry usage must be an object";
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ]) {
    const value = usage[key];
    if (
      (key === "inputTokens" ||
        key === "outputTokens" ||
        value !== undefined) &&
      !tokenCount(value)
    ) {
      return `model telemetry ${key} must be a non-negative safe integer`;
    }
  }
  if (
    telemetry.retries !== undefined &&
    (!Number.isSafeInteger(telemetry.retries) ||
      (telemetry.retries as number) < 0)
  ) {
    return "model telemetry retries must be a non-negative safe integer";
  }
  if (
    telemetry.costUsd !== undefined &&
    !nonNegativeNumber(telemetry.costUsd)
  ) {
    return "model telemetry costUsd must be a non-negative finite number";
  }
  for (const key of ["requestId", "servedModel"]) {
    if (telemetry[key] !== undefined && typeof telemetry[key] !== "string") {
      return `model telemetry ${key} must be a string`;
    }
  }

  if (root.providerSnapshot !== undefined) {
    const snapshot = record(root.providerSnapshot);
    if (
      snapshot === null ||
      typeof snapshot.provider !== "string" ||
      snapshot.provider.length === 0
    ) {
      return "provider snapshot must identify a provider";
    }
    if (snapshot.rawArtifact !== undefined) {
      const issue = artifactError(snapshot.rawArtifact);
      if (issue !== null)
        return `provider snapshot artifact is invalid: ${issue}`;
    }
    if (snapshot.raw === undefined && snapshot.rawArtifact === undefined) {
      return "provider snapshot must retain raw data or an artifact";
    }
  }
  return null;
}

async function appendOutcome(
  options: AgentLoopOptions,
  outcome: LoopOutcome,
): Promise<LoopOutcome> {
  await options.journal.append(options.sessionId, {
    category: "control",
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
    invocationId: createId("invocation"),
    sessionId: options.sessionId,
    turnId,
    call,
    idempotencyKey: `${options.sessionId}:${call.id}`,
  };
  await options.journal.append(options.sessionId, {
    category: "trace",
    type: EVENT_TYPES.actionStarted,
    turnId,
    data: { invocation },
  });

  let receipt: ActionReceipt;
  try {
    receipt = await options.actions.execute(invocation, options.signal);
    if (receipt.invocationId !== invocation.invocationId) {
      throw new Error(
        `receipt correlation mismatch: expected ${invocation.invocationId}, got ${receipt.invocationId}`,
      );
    }
    if (
      !["succeeded", "failed", "pending", "unknown"].includes(receipt.status)
    ) {
      throw new Error(`invalid action status: ${String(receipt.status)}`);
    }
    if (!Array.isArray(receipt.content))
      throw new Error("action receipt content must be an array");
    assertJsonSerializable(receipt);
    const contentError = contentProtocolError(
      receipt.content,
      "action receipt content",
    );
    if (contentError !== null) throw new Error(contentError);
    if (receipt.evidenceRefs !== undefined) {
      if (!Array.isArray(receipt.evidenceRefs))
        throw new Error("action receipt evidenceRefs must be an array");
      for (const ref of receipt.evidenceRefs) {
        const issue = artifactError(ref);
        if (issue !== null)
          throw new Error(`action receipt evidence ref is invalid: ${issue}`);
      }
    }
  } catch (error) {
    receipt = {
      invocationId: invocation.invocationId,
      status: "failed",
      content: [{ type: "text", text: errorText(error) }],
      metadata: { thrown: true },
    };
  }

  await options.journal.append(options.sessionId, {
    category: "trace",
    type: EVENT_TYPES.actionCompleted,
    turnId,
    data: { invocation, receipt },
  });
  return receipt;
}

function resultMessage(
  invocation: ActionInvocation,
  receipt: ActionReceipt,
): CanonicalMessage {
  return {
    id: createId("msg"),
    role: "tool",
    createdAt: nowIso(),
    content: [
      {
        type: "tool_result",
        toolCallId: invocation.call.id,
        name: invocation.call.name,
        isError: receipt.status !== "succeeded",
        content: receipt.content,
      },
    ],
    metadata: {
      invocationId: receipt.invocationId,
      status: receipt.status,
      evidenceRefs: receipt.evidenceRefs ?? [],
    },
  };
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
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<LoopOutcome> {
  const limit = options.maxTurns ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("maxTurns must be a non-negative safe integer");
  }
  let turns = 0;
  const priorEvents = await options.journal.read(options.sessionId);
  const priorActionState = inspectActionState(priorEvents);
  for (const missing of priorActionState.missingResults) {
    await options.journal.append(
      options.sessionId,
      messageEvent(
        resultMessage(missing.invocation, missing.receipt),
        missing.invocation.turnId,
      ),
    );
  }
  if (
    priorActionState.unresolved.length > 0 ||
    priorActionState.unstartedCalls.length > 0
  ) {
    return appendOutcome(options, {
      status: "checkpointed",
      turns,
      reason:
        priorActionState.unresolved.length > 0
          ? `${priorActionState.unresolved.length} action(s) require receipt reconciliation`
          : `${priorActionState.unstartedCalls.length} tool call(s) were journaled before execution started`,
    });
  }

  while (turns < limit) {
    if (options.signal?.aborted === true) {
      return appendOutcome(options, { status: "cancelled", turns });
    }

    turns += 1;
    const turnId = createId("turn");
    const context =
      options.project === undefined
        ? projectContext(
            options.sessionId,
            await options.journal.read(options.sessionId),
          )
        : await options.project();

    await options.journal.append(options.sessionId, {
      category: "trace",
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
        {
          sessionId: options.sessionId,
          turnId,
          config: options.config,
          context,
        },
        options.signal,
      );
    } catch (error) {
      const message = errorText(error);
      await options.journal.append(options.sessionId, {
        category: "trace",
        type: EVENT_TYPES.modelCallCompleted,
        turnId,
        data: {
          error: message,
          telemetry: {
            provider: options.config.provider.provider,
            model: options.config.provider.model,
            latencyMs: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "error",
          },
        },
      });
      return appendOutcome(options, {
        status: "failed",
        turns,
        error: message,
      });
    }

    const protocolError = modelProtocolError(response);
    if (protocolError !== null) {
      await options.journal.append(options.sessionId, {
        category: "trace",
        type: EVENT_TYPES.modelCallCompleted,
        turnId,
        data: {
          error: protocolError,
          telemetry: {
            provider: options.config.provider.provider,
            model: options.config.provider.model,
            latencyMs: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "error",
          },
        },
      });
      await options.journal.append(options.sessionId, {
        category: "trace",
        type: EVENT_TYPES.modelProtocolError,
        turnId,
        data: { error: protocolError },
      });
      return appendOutcome(options, {
        status: "failed",
        turns,
        error: protocolError,
      });
    }
    await options.journal.append(options.sessionId, {
      category: "trace",
      type: EVENT_TYPES.modelCallCompleted,
      turnId,
      data: {
        telemetry: response.telemetry,
        ...(response.providerSnapshot === undefined
          ? {}
          : { providerSnapshot: response.providerSnapshot }),
      },
    });
    await options.journal.append(
      options.sessionId,
      messageEvent(response.message, turnId),
    );

    const calls = toolCalls(response.message);
    if (calls.length === 0) {
      if (response.telemetry.stopReason === "error") {
        return appendOutcome(options, {
          status: "failed",
          turns,
          error: "provider returned an error termination",
        });
      }
      if (response.telemetry.stopReason === "aborted") {
        return appendOutcome(options, { status: "cancelled", turns });
      }
      if (response.telemetry.stopReason === "length") {
        return appendOutcome(options, {
          status: "checkpointed",
          turns,
          reason: "model output limit reached",
        });
      }
      if (
        response.telemetry.stopReason === "pause" ||
        response.telemetry.stopReason === "tool_use" ||
        response.telemetry.stopReason === "unknown"
      ) {
        return appendOutcome(options, {
          status: "checkpointed",
          turns,
          reason: `provider stopped with ${response.telemetry.stopReason} and no executable tool call`,
        });
      }
      if (response.telemetry.stopReason === "content_filter") {
        return appendOutcome(options, {
          status: "failed",
          turns,
          error: "provider refused or filtered the response",
        });
      }
      return appendOutcome(options, { status: "completed", turns });
    }

    const receipts = await Promise.all(
      calls.map((call) => executeOne(options, turnId, call)),
    );
    for (const [index, call] of calls.entries()) {
      const receipt = receipts[index]!;
      const invocation: ActionInvocation = {
        invocationId: receipt.invocationId,
        sessionId: options.sessionId,
        turnId,
        call,
        idempotencyKey: `${options.sessionId}:${call.id}`,
      };
      await options.journal.append(
        options.sessionId,
        messageEvent(resultMessage(invocation, receipt), turnId),
      );
    }

    if (
      receipts.some(
        (receipt) =>
          receipt.status === "pending" || receipt.status === "unknown",
      )
    ) {
      return appendOutcome(options, {
        status: "checkpointed",
        turns,
        reason: "an action requires postcondition reconciliation",
      });
    }
  }

  return appendOutcome(options, { status: "limited", turns, limit });
}
