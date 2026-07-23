import { validateChain } from "./journal.js";
import { assertJsonSerializable, cloneJson } from "./json.js";
import type {
  AppendEventInput,
  ArtifactRef,
  CanonicalMessage,
  ContextCompaction,
  ContextProjection,
  JournalEvent,
} from "./protocol.js";

export const EVENT_TYPES = {
  sessionStarted: "session.started",
  messageAppended: "message.appended",
  contextCompacted: "context.compacted",
  modelCallStarted: "model.call.started",
  modelCallCompleted: "model.call.completed",
  modelCallInterrupted: "model.call.interrupted",
  modelProtocolError: "model.protocol.error",
  actionStarted: "action.started",
  actionCompleted: "action.completed",
  childStarted: "child.started",
  childCompleted: "child.completed",
  runCompleted: "run.completed",
} as const;

function dataRecord(event: JournalEvent): Record<string, unknown> {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  )
    return {};
  return event.data as Record<string, unknown>;
}

function eventMessage(event: JournalEvent): CanonicalMessage | null {
  if (!event.affectsContext) return null;
  const message = dataRecord(event).message;
  if (typeof message !== "object" || message === null) return null;
  return message as CanonicalMessage;
}

function compactionData(event: JournalEvent): ContextCompaction | null {
  if (event.type !== EVENT_TYPES.contextCompacted) return null;
  const data = dataRecord(event);
  if (
    typeof data.summarizesThroughEventId !== "string" ||
    !isCanonicalMessage(data.summary) ||
    !Array.isArray(data.evidenceRefs) ||
    (data.scope !== "local" && data.scope !== "including_inherited") ||
    !Number.isSafeInteger(data.projectorVersion) ||
    (data.projectorVersion as number) < 1
  ) {
    return null;
  }
  return data as unknown as ContextCompaction;
}

function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const message = value as Partial<CanonicalMessage>;
  return (
    typeof message.id === "string" &&
    ["system", "user", "assistant", "tool"].includes(message.role ?? "") &&
    Array.isArray(message.content) &&
    typeof message.createdAt === "string"
  );
}

function artifactRefs(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is ArtifactRef => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const ref = candidate as Partial<ArtifactRef>;
    return (
      typeof ref.sha256 === "string" &&
      typeof ref.uri === "string" &&
      typeof ref.bytes === "number" &&
      typeof ref.mediaType === "string"
    );
  });
}

function eventEvidenceRefs(event: JournalEvent): ArtifactRef[] {
  const data = dataRecord(event);
  const message =
    typeof data.message === "object" && data.message !== null
      ? (data.message as CanonicalMessage)
      : undefined;
  const result =
    typeof data.result === "object" && data.result !== null
      ? (data.result as Record<string, unknown>)
      : {};
  return [
    ...artifactRefs(data.evidenceRefs),
    ...artifactRefs(result.evidenceRefs),
    ...artifactRefs(message?.metadata?.evidenceRefs),
  ];
}

function unpairedToolCallError(
  events: JournalEvent[],
  boundaryIndex: number,
): string | null {
  const open = new Set<string>();
  for (const event of events.slice(0, boundaryIndex + 1)) {
    const message = eventMessage(event);
    if (message === null || !Array.isArray(message.content)) continue;
    for (const candidate of message.content) {
      const block =
        typeof candidate === "object" && candidate !== null
          ? (candidate as unknown as Record<string, unknown>)
          : null;
      if (block?.type === "tool_call" && typeof block.id === "string") {
        open.add(block.id);
      }
      if (
        block?.type === "tool_result" &&
        typeof block.toolCallId === "string"
      ) {
        open.delete(block.toolCallId);
      }
    }
  }
  if (open.size === 0) return null;
  return `compaction boundary separates tool call(s) ${[...open].join(", ")} from their results`;
}

/**
 * A compaction boundary must not separate a tool call from its recorded
 * result; the projected transcript would carry unpaired blocks that provider
 * encoders and APIs reject. Returns null when the boundary is safe. Check
 * before appending a compaction event; projectContext() ignores compactions
 * with unsafe boundaries.
 */
export function compactionBoundaryError(
  sessionId: string,
  events: JournalEvent[],
  summarizesThroughEventId: string,
): string | null {
  validateChain(sessionId, events);
  const boundaryIndex = events.findIndex(
    (event) => event.id === summarizesThroughEventId,
  );
  if (boundaryIndex < 0) {
    return `compaction boundary event ${summarizesThroughEventId} is not in the journal`;
  }
  return unpairedToolCallError(events, boundaryIndex);
}

export interface ProjectContextOptions {
  inheritedMessages?: CanonicalMessage[];
  inheritedEvidenceRefs?: ArtifactRef[];
}

/**
 * Builds the model-facing view without modifying the raw events. The most
 * recent valid compaction replaces covered messages; all later messages remain
 * verbatim. Unknown events are retained in storage and ignored by this view.
 */
export function projectContext(
  sessionId: string,
  events: JournalEvent[],
  options: ProjectContextOptions = {},
): ContextProjection {
  validateChain(sessionId, events);
  let latest:
    | { event: JournalEvent; data: ContextCompaction; boundaryIndex: number }
    | undefined;
  for (
    let compactionIndex = events.length - 1;
    compactionIndex >= 0;
    compactionIndex -= 1
  ) {
    const event = events[compactionIndex]!;
    const data = compactionData(event);
    if (data === null) continue;
    const boundaryIndex = events.findIndex(
      (candidate) => candidate.id === data.summarizesThroughEventId,
    );
    if (
      boundaryIndex >= 0 &&
      boundaryIndex < compactionIndex &&
      unpairedToolCallError(events, boundaryIndex) === null
    ) {
      latest = { event, data, boundaryIndex };
      break;
    }
  }

  let localStart = 0;
  let messages = [...(options.inheritedMessages ?? [])];
  let evidenceRefs = [...(options.inheritedEvidenceRefs ?? [])];
  let compactionEventId: string | null = null;

  if (latest !== undefined) {
    localStart = latest.boundaryIndex + 1;
    if (latest.data.scope === "including_inherited") messages = [];
    messages.push(latest.data.summary);
    evidenceRefs = [
      ...(latest.data.scope === "including_inherited"
        ? []
        : (options.inheritedEvidenceRefs ?? [])),
      ...latest.data.evidenceRefs,
    ];
    compactionEventId = latest.event.id;
  }

  for (const event of events.slice(localStart)) {
    if (event.type === EVENT_TYPES.contextCompacted) continue;
    const message = eventMessage(event);
    if (message !== null) messages.push(message);
    evidenceRefs.push(...eventEvidenceRefs(event));
  }

  const head = events.at(-1);
  return {
    sessionId,
    messages: supersedeToolResults(messages),
    rawThroughEventId: head?.id ?? null,
    rawThroughSequence: head?.sequence ?? 0,
    compactionEventId,
    evidenceRefs: deduplicateArtifacts(evidenceRefs),
  };
}

/**
 * A reconciled action appends a second tool-result message for the same call.
 * Providers reject duplicate tool results, so the projected context keeps only
 * the latest result per call; the raw journal retains every receipt.
 */
function supersedeToolResults(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  const lastResultIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === "tool_result")
        lastResultIndex.set(block.toolCallId, index);
    }
  });
  return messages.flatMap((message, index) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return [message];
    }
    const content = message.content.filter(
      (block) =>
        block.type !== "tool_result" ||
        lastResultIndex.get(block.toolCallId) === index,
    );
    if (content.length === message.content.length) return [message];
    if (content.length === 0) return [];
    return [{ ...message, content }];
  });
}

export function messageEvent(
  message: CanonicalMessage,
  turnId: string | null = null,
): AppendEventInput<{ message: CanonicalMessage }> {
  return {
    category: "context",
    type: EVENT_TYPES.messageAppended,
    affectsContext: true,
    turnId,
    data: { message },
  };
}

export function compactionEvent(
  data: ContextCompaction,
  turnId: string | null = null,
): AppendEventInput<ContextCompaction> {
  return {
    category: "context",
    type: EVENT_TYPES.contextCompacted,
    affectsContext: true,
    turnId,
    data,
  };
}

function deduplicateArtifacts(refs: ArtifactRef[]): ArtifactRef[] {
  return [...new Map(refs.map((ref) => [ref.sha256, ref])).values()];
}

export interface ProjectionDefinition<TState> {
  name: string;
  version: number;
  initial(): TState;
  reduce(state: TState, event: JournalEvent): TState;
}

export interface ProjectionSnapshot<TState> {
  name: string;
  version: number;
  sessionId: string;
  throughSequence: number;
  throughEventId: string | null;
  state: TState;
}

export function foldProjection<TState>(
  sessionId: string,
  events: JournalEvent[],
  definition: ProjectionDefinition<TState>,
  prior?: ProjectionSnapshot<TState>,
): ProjectionSnapshot<TState> {
  if (
    prior !== undefined &&
    (prior.name !== definition.name ||
      prior.version !== definition.version ||
      prior.sessionId !== sessionId)
  ) {
    throw new Error(
      "projection snapshot does not match its definition or session",
    );
  }
  if (prior !== undefined) {
    if (
      !Number.isSafeInteger(prior.throughSequence) ||
      prior.throughSequence < 0 ||
      (prior.throughSequence === 0
        ? prior.throughEventId !== null
        : typeof prior.throughEventId !== "string" ||
          prior.throughEventId.length === 0)
    ) {
      throw new Error("projection snapshot has an invalid journal boundary");
    }
    if (events[0]?.sequence === 1) {
      validateChain(sessionId, events);
      const boundary =
        prior.throughSequence === 0
          ? undefined
          : events[prior.throughSequence - 1];
      if (
        prior.throughSequence > 0 &&
        (boundary?.sequence !== prior.throughSequence ||
          boundary.id !== prior.throughEventId)
      ) {
        throw new Error("projection snapshot does not match the raw journal");
      }
    } else {
      validateChain(sessionId, events, {
        parentId: prior.throughEventId,
        startingSequence: prior.throughSequence + 1,
      });
    }
  } else {
    validateChain(sessionId, events);
  }

  let state = cloneJson(prior?.state ?? definition.initial());
  const remaining = events.filter(
    (event) => event.sequence > (prior?.throughSequence ?? 0),
  );
  for (const event of remaining) state = definition.reduce(state, event);
  const head = remaining.at(-1);
  return {
    name: definition.name,
    version: definition.version,
    sessionId,
    throughSequence: head?.sequence ?? prior?.throughSequence ?? 0,
    throughEventId: head?.id ?? prior?.throughEventId ?? null,
    state,
  };
}

export interface ProjectionStore {
  /** Load a disposable view; null means the caller should rebuild it. */
  load<TState>(
    sessionId: string,
    name: string,
    version: number,
  ): Promise<ProjectionSnapshot<TState> | null>;
  save<TState>(snapshot: ProjectionSnapshot<TState>): Promise<void>;
}

export function assertProjectionSnapshot<TState>(
  snapshot: ProjectionSnapshot<TState>,
  expected?: { sessionId: string; name: string; version: number },
): void {
  assertJsonSerializable(snapshot);
  if (
    typeof snapshot.sessionId !== "string" ||
    snapshot.sessionId.length === 0 ||
    typeof snapshot.name !== "string" ||
    snapshot.name.length === 0 ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    !Number.isSafeInteger(snapshot.throughSequence) ||
    snapshot.throughSequence < 0 ||
    (snapshot.throughSequence === 0
      ? snapshot.throughEventId !== null
      : typeof snapshot.throughEventId !== "string" ||
        snapshot.throughEventId.length === 0)
  ) {
    throw new TypeError("projection snapshot envelope is invalid");
  }
  if (
    expected !== undefined &&
    (snapshot.sessionId !== expected.sessionId ||
      snapshot.name !== expected.name ||
      snapshot.version !== expected.version)
  ) {
    throw new Error("projection snapshot identity mismatch");
  }
}

/** Ephemeral replaceable views for tests and runtime-local caches. */
export class MemoryProjectionStore implements ProjectionStore {
  private readonly snapshots = new Map<string, ProjectionSnapshot<unknown>>();

  async load<TState>(
    sessionId: string,
    name: string,
    version: number,
  ): Promise<ProjectionSnapshot<TState> | null> {
    const snapshot = this.snapshots.get(this.key(sessionId, name, version));
    if (snapshot === undefined) return null;
    assertProjectionSnapshot(snapshot, { sessionId, name, version });
    return cloneJson(snapshot) as ProjectionSnapshot<TState>;
  }

  async save<TState>(snapshot: ProjectionSnapshot<TState>): Promise<void> {
    assertProjectionSnapshot(snapshot);
    this.snapshots.set(
      this.key(snapshot.sessionId, snapshot.name, snapshot.version),
      cloneJson(snapshot) as ProjectionSnapshot<unknown>,
    );
  }

  private key(sessionId: string, name: string, version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError("projection version must be a positive safe integer");
    }
    return JSON.stringify([sessionId, name, version]);
  }
}
