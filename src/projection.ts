import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createId } from './ids.js';
import type {
  AppendEventInput,
  ArtifactRef,
  CanonicalMessage,
  ContextCompaction,
  ContextProjection,
  JournalEvent,
} from './protocol.js';

export const EVENT_TYPES = {
  sessionStarted: 'session.started',
  messageAppended: 'message.appended',
  contextCompacted: 'context.compacted',
  modelCallStarted: 'model.call.started',
  modelCallCompleted: 'model.call.completed',
  actionStarted: 'action.started',
  actionCompleted: 'action.completed',
  childStarted: 'child.started',
  childCompleted: 'child.completed',
  runCompleted: 'run.completed',
} as const;

function dataRecord(event: JournalEvent): Record<string, unknown> {
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return {};
  return event.data as Record<string, unknown>;
}

function eventMessage(event: JournalEvent): CanonicalMessage | null {
  if (!event.affectsContext) return null;
  const message = dataRecord(event).message;
  if (typeof message !== 'object' || message === null) return null;
  return message as CanonicalMessage;
}

function compactionData(event: JournalEvent): ContextCompaction | null {
  if (event.type !== EVENT_TYPES.contextCompacted) return null;
  const data = dataRecord(event);
  if (
    typeof data.summarizesThroughEventId !== 'string' ||
    typeof data.summary !== 'object' ||
    data.summary === null
  ) {
    return null;
  }
  return data as unknown as ContextCompaction;
}

function artifactRefs(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is ArtifactRef => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const ref = candidate as Partial<ArtifactRef>;
    return (
      typeof ref.sha256 === 'string' &&
      typeof ref.uri === 'string' &&
      typeof ref.bytes === 'number' &&
      typeof ref.mediaType === 'string'
    );
  });
}

function eventEvidenceRefs(event: JournalEvent): ArtifactRef[] {
  const data = dataRecord(event);
  const message =
    typeof data.message === 'object' && data.message !== null
      ? (data.message as CanonicalMessage)
      : undefined;
  const result =
    typeof data.result === 'object' && data.result !== null
      ? (data.result as Record<string, unknown>)
      : {};
  return [
    ...artifactRefs(data.evidenceRefs),
    ...artifactRefs(result.evidenceRefs),
    ...artifactRefs(message?.metadata?.evidenceRefs),
  ];
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
  let latest:
    | { event: JournalEvent; data: ContextCompaction; boundaryIndex: number }
    | undefined;
  for (let compactionIndex = events.length - 1; compactionIndex >= 0; compactionIndex -= 1) {
    const event = events[compactionIndex]!;
    const data = compactionData(event);
    if (data === null) continue;
    const boundaryIndex = events.findIndex(
      (candidate) => candidate.id === data.summarizesThroughEventId,
    );
    if (boundaryIndex >= 0 && boundaryIndex < compactionIndex) {
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
    if (latest.data.scope === 'including_inherited') messages = [];
    messages.push(latest.data.summary);
    evidenceRefs = [
      ...(latest.data.scope === 'including_inherited'
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
    messages,
    rawThroughEventId: head?.id ?? null,
    rawThroughSequence: head?.sequence ?? 0,
    compactionEventId,
    evidenceRefs: deduplicateArtifacts(evidenceRefs),
  };
}

export function messageEvent(
  message: CanonicalMessage,
  turnId: string | null = null,
): AppendEventInput<{ message: CanonicalMessage }> {
  return {
    category: 'context',
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
    category: 'context',
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
    throw new Error('projection snapshot does not match its definition or session');
  }

  let state = prior?.state ?? definition.initial();
  const remaining = events.filter((event) => event.sequence > (prior?.throughSequence ?? 0));
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
  load<TState>(
    sessionId: string,
    name: string,
    version: number,
  ): Promise<ProjectionSnapshot<TState> | null>;
  save<TState>(snapshot: ProjectionSnapshot<TState>): Promise<void>;
}

/** Replaceable cold/materialized views. Raw journals remain authoritative. */
export class FileProjectionStore implements ProjectionStore {
  constructor(readonly rootDirectory: string) {}

  async load<TState>(
    sessionId: string,
    name: string,
    version: number,
  ): Promise<ProjectionSnapshot<TState> | null> {
    try {
      return JSON.parse(await readFile(this.path(sessionId, name, version), 'utf8')) as ProjectionSnapshot<TState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save<TState>(snapshot: ProjectionSnapshot<TState>): Promise<void> {
    const path = this.path(snapshot.sessionId, snapshot.name, snapshot.version);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${createId('projection')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  }

  private path(sessionId: string, name: string, version: number): string {
    return join(
      this.rootDirectory,
      encodeURIComponent(sessionId),
      `${encodeURIComponent(name)}-v${version}.json`,
    );
  }
}
