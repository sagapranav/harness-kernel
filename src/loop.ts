import { assertArtifactRef } from "./artifacts.js";
import { assertJsonSerializable } from "./json.js";
import type { JournalStore } from "./journal.js";
import { EVENT_TYPES, messageEvent, projectContext } from "./projection.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import type {
  ActionInvocation,
  ActionReceipt,
  AppendEventInput,
  CanonicalMessage,
  ContextProjection,
  ImmutableRunConfig,
  JournalEvent,
  LoopOutcome,
  ModelStreamEvent,
  NormalizedModelResponse,
  ToolCallBlock,
} from "./protocol.js";

export interface ModelRequest {
  sessionId: string;
  turnId: string;
  config: ImmutableRunConfig;
  context: ContextProjection;
  /**
   * Present when the host wants incremental output. A streaming-capable
   * invoker forwards deltas here and still returns the complete normalized
   * response; a non-streaming invoker may ignore it.
   */
  onStream?: (event: ModelStreamEvent) => void;
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
  /** Host hook for renewing queue/session leases before every bounded turn. */
  beforeTurn?: () => Promise<void>;
  /**
   * Graceful host deadline hook. Return a reason before a new turn to persist a
   * checkpointed outcome that a queue worker may continue in another process.
   */
  shouldCheckpoint?: () => string | null;
  /** Host identity/time services; inject for deterministic or non-default runtimes. */
  runtime?: RuntimeServices;
  /**
   * Override context construction for retrieval, inherited child context, or
   * application-specific projections.
   */
  project?: () => Promise<ContextProjection>;
  /**
   * Host postcondition check for an action interrupted before its completion
   * event, or resolved as pending/unknown. Return a terminal receipt to record
   * the established result and let the run continue; return null to leave the
   * session checkpointed for a later reconciliation attempt.
   */
  reconcileAction?: (item: {
    invocation: ActionInvocation;
    receipt?: ActionReceipt;
  }) => Promise<ActionReceipt | null>;
  /**
   * Retry policy for thrown model invocations. Return a delay in milliseconds
   * to retry the same turn, or null to record a failed outcome. Every attempt
   * is journaled as its own model.call.started/completed pair.
   */
  modelRetryDelayMs?: (
    error: unknown,
    attempt: number,
  ) => number | null | Promise<number | null>;
  /**
   * Receives incremental model output forwarded from the invoker. Streaming
   * is a live projection for UIs; the journal still records only complete
   * responses, so nothing durable depends on having observed the stream.
   */
  onModelStream?: (event: ModelStreamEvent, turnId: string) => void;
}

/** Reads through a function call so control flow narrowing cannot cache it. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
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
        if (block.details !== undefined && !Array.isArray(block.details))
          return `${path}[${index}].details must be an array`;
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
  /** Calls journaled in an assistant message before any execution trace. */
  unstartedCalls: Array<{ call: ToolCallBlock; turnId: string | null }>;
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
  const calls = new Map<
    string,
    { call: ToolCallBlock; turnId: string | null }
  >();
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
            calls.set(block.id, {
              call: block as unknown as ToolCallBlock,
              turnId: event.turnId,
            });
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
    ({ call }) => !startedCallIds.has(call.id) && !resultCallIds.has(call.id),
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

function receiptProtocolError(
  invocation: ActionInvocation,
  receipt: ActionReceipt,
): string | null {
  if (receipt.invocationId !== invocation.invocationId) {
    return `receipt correlation mismatch: expected ${invocation.invocationId}, got ${receipt.invocationId}`;
  }
  if (!["succeeded", "failed", "pending", "unknown"].includes(receipt.status)) {
    return `invalid action status: ${String(receipt.status)}`;
  }
  if (!Array.isArray(receipt.content))
    return "action receipt content must be an array";
  try {
    assertJsonSerializable(receipt);
  } catch (error) {
    return errorText(error);
  }
  const contentError = contentProtocolError(
    receipt.content,
    "action receipt content",
  );
  if (contentError !== null) return contentError;
  if (receipt.evidenceRefs !== undefined) {
    if (!Array.isArray(receipt.evidenceRefs))
      return "action receipt evidenceRefs must be an array";
    for (const ref of receipt.evidenceRefs) {
      const issue = artifactError(ref);
      if (issue !== null)
        return `action receipt evidence ref is invalid: ${issue}`;
    }
  }
  return null;
}

/**
 * Serializes loop writes behind one tracked head so every append is an
 * expected-head compare-and-append. A concurrent foreign writer surfaces as a
 * JournalConflictError from the store instead of an interleaved transcript.
 */
class SessionAppender {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journal: JournalStore,
    private readonly sessionId: string,
    private headId: string | null,
  ) {}

  append<TData>(input: AppendEventInput<TData>): Promise<JournalEvent<TData>> {
    const run = this.queue.then(async () => {
      const event = await this.journal.append(this.sessionId, input, {
        expectedHeadId: this.headId,
      });
      this.headId = event.id;
      return event;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

async function appendOutcome(
  appender: SessionAppender,
  outcome: LoopOutcome,
): Promise<LoopOutcome> {
  await appender.append({
    category: "control",
    type: EVENT_TYPES.runCompleted,
    data: { outcome },
  });
  return outcome;
}

async function executeOne(
  options: AgentLoopOptions,
  appender: SessionAppender,
  turnId: string | null,
  call: ToolCallBlock,
): Promise<{ invocation: ActionInvocation; receipt: ActionReceipt }> {
  const invocation: ActionInvocation = {
    invocationId: (options.runtime ?? defaultRuntime).createId("invocation"),
    sessionId: options.sessionId,
    turnId: turnId ?? "",
    call,
    idempotencyKey: `${options.sessionId}:${call.id}`,
  };
  await appender.append({
    category: "trace",
    type: EVENT_TYPES.actionStarted,
    turnId,
    data: { invocation },
  });

  let receipt: ActionReceipt;
  try {
    receipt = await options.actions.execute(invocation, options.signal);
    const receiptError = receiptProtocolError(invocation, receipt);
    if (receiptError !== null) throw new Error(receiptError);
  } catch (error) {
    receipt = {
      invocationId: invocation.invocationId,
      status: "failed",
      content: [{ type: "text", text: errorText(error) }],
      metadata: { thrown: true },
    };
  }

  await appender.append({
    category: "trace",
    type: EVENT_TYPES.actionCompleted,
    turnId,
    data: { invocation, receipt },
  });
  return { invocation, receipt };
}

function resultMessage(
  invocation: ActionInvocation,
  receipt: ActionReceipt,
  runtime: RuntimeServices,
): CanonicalMessage {
  return {
    id: runtime.createId("msg"),
    role: "tool",
    createdAt: runtime.nowIso(),
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
 * Records a host-established terminal receipt for an action that was
 * interrupted before its completion event or resolved as pending/unknown.
 * The next runAgentLoop() start appends the matching tool-result message and
 * resumes the session. Prefer the `reconcileAction` loop option when the host
 * can check the postcondition inline.
 */
export async function appendActionReconciliation(
  journal: JournalStore,
  invocation: ActionInvocation,
  receipt: ActionReceipt,
): Promise<JournalEvent> {
  if (receipt.status !== "succeeded" && receipt.status !== "failed") {
    throw new TypeError(
      "reconciled receipts must have a terminal succeeded/failed status",
    );
  }
  const receiptError = receiptProtocolError(invocation, receipt);
  if (receiptError !== null) throw new TypeError(receiptError);
  return journal.append(invocation.sessionId, {
    category: "trace",
    type: EVENT_TYPES.actionCompleted,
    turnId: invocation.turnId,
    data: { invocation, receipt },
  });
}

function outcomeForFinalStop(stopReason: string, turns: number): LoopOutcome {
  if (stopReason === "error") {
    return {
      status: "failed",
      turns,
      error: "provider returned an error termination",
    };
  }
  if (stopReason === "aborted") return { status: "cancelled", turns };
  if (stopReason === "length") {
    return {
      status: "checkpointed",
      turns,
      reason: "model output limit reached",
    };
  }
  if (
    stopReason === "pause" ||
    stopReason === "tool_use" ||
    stopReason === "unknown"
  ) {
    return {
      status: "checkpointed",
      turns,
      reason: `provider stopped with ${stopReason} and no executable tool call`,
    };
  }
  if (stopReason === "content_filter") {
    return {
      status: "failed",
      turns,
      error: "provider refused or filtered the response",
    };
  }
  return { status: "completed", turns };
}

/** Events after the most recent run.completed, i.e. the interrupted run. */
function openRunSegment(events: JournalEvent[]): JournalEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === EVENT_TYPES.runCompleted) {
      return events.slice(index + 1);
    }
  }
  return events;
}

interface ModelCallState {
  /** model.call.started with no later completion or interruption marker. */
  danglingStartEventId: string | null;
  danglingTurnId: string | null;
  /** The last successful completion, if any, and what followed it. */
  lastCompleted: {
    eventId: string;
    turnId: string | null;
    error: string | null;
    stopReason: string | null;
  } | null;
  assistantAfterLastCompleted: CanonicalMessage | null;
  contextMessageAfterAssistant: boolean;
}

function inspectModelCallState(segment: JournalEvent[]): ModelCallState {
  const state: ModelCallState = {
    danglingStartEventId: null,
    danglingTurnId: null,
    lastCompleted: null,
    assistantAfterLastCompleted: null,
    contextMessageAfterAssistant: false,
  };
  for (const event of segment) {
    const data = eventRecord(event);
    if (event.type === EVENT_TYPES.modelCallStarted) {
      state.danglingStartEventId = event.id;
      state.danglingTurnId = event.turnId;
    } else if (
      event.type === EVENT_TYPES.modelCallCompleted ||
      event.type === EVENT_TYPES.modelCallInterrupted
    ) {
      state.danglingStartEventId = null;
      state.danglingTurnId = null;
      if (event.type === EVENT_TYPES.modelCallCompleted) {
        const telemetry = record(data.telemetry);
        state.lastCompleted = {
          eventId: event.id,
          turnId: event.turnId,
          error: typeof data.error === "string" ? data.error : null,
          stopReason:
            typeof telemetry?.stopReason === "string"
              ? telemetry.stopReason
              : null,
        };
        state.assistantAfterLastCompleted = null;
        state.contextMessageAfterAssistant = false;
      }
    } else if (event.type === EVENT_TYPES.messageAppended) {
      const message =
        typeof data.message === "object" && data.message !== null
          ? (data.message as CanonicalMessage)
          : null;
      if (message === null) continue;
      if (
        message.role === "assistant" &&
        state.lastCompleted !== null &&
        state.assistantAfterLastCompleted === null
      ) {
        state.assistantAfterLastCompleted = message;
      } else if (state.assistantAfterLastCompleted !== null) {
        state.contextMessageAfterAssistant = true;
      }
    }
  }
  return state;
}

/**
 * Repairs crash-boundary state before the first new model call. Returns a
 * terminal outcome when the interrupted run's conclusion can be established
 * without invoking the model, or null to continue into the turn loop.
 */
async function recoverCrashBoundary(
  options: AgentLoopOptions,
  runtime: RuntimeServices,
  appender: SessionAppender,
  events: JournalEvent[],
): Promise<LoopOutcome | null> {
  const actionState = inspectActionState(events);
  for (const missing of actionState.missingResults) {
    await appender.append(
      messageEvent(
        resultMessage(missing.invocation, missing.receipt, runtime),
        missing.invocation.turnId,
      ),
    );
  }

  const unreconciled: ActionStateInspection["unresolved"] = [];
  for (const item of actionState.unresolved) {
    const receipt =
      options.reconcileAction === undefined
        ? null
        : await options.reconcileAction(item);
    if (
      receipt === null ||
      (receipt.status !== "succeeded" && receipt.status !== "failed")
    ) {
      unreconciled.push(item);
      continue;
    }
    const receiptError = receiptProtocolError(item.invocation, receipt);
    if (receiptError !== null) {
      throw new TypeError(`reconciled receipt is invalid: ${receiptError}`);
    }
    await appender.append({
      category: "trace",
      type: EVENT_TYPES.actionCompleted,
      turnId: item.invocation.turnId,
      data: { invocation: item.invocation, receipt },
    });
    await appender.append(
      messageEvent(
        resultMessage(item.invocation, receipt, runtime),
        item.invocation.turnId,
      ),
    );
  }
  if (unreconciled.length > 0) {
    return appendOutcome(appender, {
      status: "checkpointed",
      turns: 0,
      reason: `${unreconciled.length} action(s) require receipt reconciliation`,
    });
  }

  // Calls journaled before any execution trace never started their side
  // effect, so executing them now is safe.
  let recoveredPending = 0;
  for (const unstarted of actionState.unstartedCalls) {
    const { invocation, receipt } = await executeOne(
      options,
      appender,
      unstarted.turnId,
      unstarted.call,
    );
    await appender.append(
      messageEvent(
        resultMessage(invocation, receipt, runtime),
        unstarted.turnId,
      ),
    );
    if (receipt.status === "pending" || receipt.status === "unknown") {
      recoveredPending += 1;
    }
  }
  if (recoveredPending > 0) {
    return appendOutcome(appender, {
      status: "checkpointed",
      turns: 0,
      reason: "an action requires postcondition reconciliation",
    });
  }

  const modelState = inspectModelCallState(openRunSegment(events));
  if (modelState.danglingStartEventId !== null) {
    // The response was never journaled; a fresh call is the only way forward.
    await appender.append({
      category: "trace",
      type: EVENT_TYPES.modelCallInterrupted,
      turnId: modelState.danglingTurnId,
      data: {
        phase: "invoke",
        interruptedEventId: modelState.danglingStartEventId,
        reason: "model call started but no completion was journaled",
      },
    });
    return null;
  }
  if (
    modelState.lastCompleted !== null &&
    modelState.lastCompleted.error === null
  ) {
    if (modelState.assistantAfterLastCompleted === null) {
      // Telemetry was recorded but the canonical message was lost.
      await appender.append({
        category: "trace",
        type: EVENT_TYPES.modelCallInterrupted,
        turnId: modelState.lastCompleted.turnId,
        data: {
          phase: "record",
          interruptedEventId: modelState.lastCompleted.eventId,
          reason:
            "model call completed but its assistant message was not journaled",
        },
      });
      return null;
    }
    if (
      !modelState.contextMessageAfterAssistant &&
      toolCalls(modelState.assistantAfterLastCompleted).length === 0 &&
      modelState.lastCompleted.stopReason !== null
    ) {
      // The turn finished; only the outcome append was lost. Replay it from
      // the recorded stop reason instead of re-invoking the model.
      return appendOutcome(
        appender,
        outcomeForFinalStop(modelState.lastCompleted.stopReason, 0),
      );
    }
  }
  return null;
}

/**
 * Minimal provider-neutral loop.
 *
 * - The model and action surface are injected.
 * - Every observation is appended before it can affect the next call.
 * - Every append is an expected-head compare-and-append; a concurrent foreign
 *   writer surfaces as a JournalConflictError and stops the loop from writing.
 * - Action completion traces may be in completion order.
 * - Tool-result context messages are appended in source-call order.
 * - Provider and action failures become events and outcomes.
 * - Crash boundaries are repaired on startup: never-started calls execute,
 *   interrupted calls go through `reconcileAction`, lost model responses are
 *   marked and re-invoked, and a finished turn's lost outcome is replayed.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<LoopOutcome> {
  const runtime = options.runtime ?? defaultRuntime;
  const limit = options.maxTurns ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("maxTurns must be a non-negative safe integer");
  }
  let turns = 0;
  const priorEvents = await options.journal.read(options.sessionId);
  const appender = new SessionAppender(
    options.journal,
    options.sessionId,
    priorEvents.at(-1)?.id ?? null,
  );
  const recovered = await recoverCrashBoundary(
    options,
    runtime,
    appender,
    priorEvents,
  );
  if (recovered !== null) return recovered;

  while (turns < limit) {
    if (options.signal?.aborted === true) {
      return appendOutcome(appender, { status: "cancelled", turns });
    }
    const checkpointReason = options.shouldCheckpoint?.() ?? null;
    if (checkpointReason !== null) {
      if (checkpointReason.length === 0) {
        throw new TypeError("checkpoint reason must not be empty");
      }
      return appendOutcome(appender, {
        status: "checkpointed",
        turns,
        reason: checkpointReason,
      });
    }
    await options.beforeTurn?.();

    turns += 1;
    const turnId = runtime.createId("turn");
    const context =
      options.project === undefined
        ? projectContext(
            options.sessionId,
            await options.journal.read(options.sessionId),
          )
        : await options.project();

    let response: NormalizedModelResponse | null = null;
    let attempt = 0;
    while (response === null) {
      await appender.append({
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
      try {
        const onModelStream = options.onModelStream;
        response = await options.model.invoke(
          {
            sessionId: options.sessionId,
            turnId,
            config: options.config,
            context,
            ...(onModelStream === undefined
              ? {}
              : {
                  onStream: (event: ModelStreamEvent) =>
                    onModelStream(event, turnId),
                }),
          },
          options.signal,
        );
      } catch (error) {
        attempt += 1;
        const message = errorText(error);
        await appender.append({
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
        const retryDelay =
          isAborted(options.signal) || options.modelRetryDelayMs === undefined
            ? null
            : await options.modelRetryDelayMs(error, attempt);
        if (retryDelay === null) {
          return appendOutcome(appender, {
            status: "failed",
            turns,
            error: message,
          });
        }
        if (!Number.isSafeInteger(retryDelay) || retryDelay < 0) {
          throw new TypeError(
            "model retry delay must be a non-negative safe integer or null",
          );
        }
        if (retryDelay > 0) await delay(retryDelay, options.signal);
        if (isAborted(options.signal)) {
          return appendOutcome(appender, { status: "cancelled", turns });
        }
      }
    }

    const protocolError = modelProtocolError(response);
    if (protocolError !== null) {
      await appender.append({
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
      await appender.append({
        category: "trace",
        type: EVENT_TYPES.modelProtocolError,
        turnId,
        data: { error: protocolError },
      });
      return appendOutcome(appender, {
        status: "failed",
        turns,
        error: protocolError,
      });
    }
    await appender.append({
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
    await appender.append(messageEvent(response.message, turnId));

    const calls = toolCalls(response.message);
    if (calls.length === 0) {
      return appendOutcome(
        appender,
        outcomeForFinalStop(response.telemetry.stopReason, turns),
      );
    }

    const executions = await Promise.all(
      calls.map((call) => executeOne(options, appender, turnId, call)),
    );
    for (const { invocation, receipt } of executions) {
      await appender.append(
        messageEvent(resultMessage(invocation, receipt, runtime), turnId),
      );
    }

    if (
      executions.some(
        ({ receipt }) =>
          receipt.status === "pending" || receipt.status === "unknown",
      )
    ) {
      return appendOutcome(appender, {
        status: "checkpointed",
        turns,
        reason: "an action requires postcondition reconciliation",
      });
    }
  }

  return appendOutcome(appender, { status: "limited", turns, limit });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal?.addEventListener("abort", settle, { once: true });
  });
}
