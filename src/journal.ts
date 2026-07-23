import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createId, nowIso } from './ids.js';
import type { AppendEventInput, JournalEvent } from './protocol.js';

export interface JournalReadOptions {
  afterSequence?: number;
  throughSequence?: number;
}

export interface AppendOptions {
  /** Optimistic-concurrency guard. `null` means the journal must be empty. */
  expectedHeadId?: string | null;
}

export interface JournalStore {
  append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>>;
  read(sessionId: string, options?: JournalReadOptions): Promise<JournalEvent[]>;
  head(sessionId: string): Promise<JournalEvent | null>;
}

export class JournalConflictError extends Error {
  constructor(
    readonly expectedHeadId: string | null,
    readonly actualHeadId: string | null,
  ) {
    super(`journal head conflict: expected ${expectedHeadId ?? '<empty>'}, got ${actualHeadId ?? '<empty>'}`);
    this.name = 'JournalConflictError';
  }
}

function select(events: JournalEvent[], options?: JournalReadOptions): JournalEvent[] {
  const after = options?.afterSequence ?? 0;
  const through = options?.throughSequence ?? Number.MAX_SAFE_INTEGER;
  return events.filter((event) => event.sequence > after && event.sequence <= through);
}

function buildEvent<TData>(
  sessionId: string,
  head: JournalEvent | null,
  input: AppendEventInput<TData>,
): JournalEvent<TData> {
  return {
    id: createId('evt'),
    sessionId,
    sequence: (head?.sequence ?? 0) + 1,
    parentId: head?.id ?? null,
    timestamp: nowIso(),
    category: input.category,
    type: input.type,
    version: input.version ?? 1,
    turnId: input.turnId ?? null,
    affectsContext: input.affectsContext ?? false,
    data: input.data,
  };
}

function assertExpectedHead(head: JournalEvent | null, options?: AppendOptions): void {
  if (options === undefined || !Object.prototype.hasOwnProperty.call(options, 'expectedHeadId')) return;
  const actual = head?.id ?? null;
  if (actual !== options.expectedHeadId) {
    throw new JournalConflictError(options.expectedHeadId ?? null, actual);
  }
}

/**
 * Deterministic test/reference store. Appends are synchronous inside the async
 * method, so JavaScript's run-to-completion semantics linearize concurrent calls.
 */
export class MemoryJournalStore implements JournalStore {
  private readonly sessions = new Map<string, JournalEvent[]>();

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    const events = this.sessions.get(sessionId) ?? [];
    const head = events.at(-1) ?? null;
    assertExpectedHead(head, options);
    const event = buildEvent(sessionId, head, input);
    events.push(event as JournalEvent);
    this.sessions.set(sessionId, events);
    return event;
  }

  async read(sessionId: string, options?: JournalReadOptions): Promise<JournalEvent[]> {
    return select([...(this.sessions.get(sessionId) ?? [])], options);
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    return this.sessions.get(sessionId)?.at(-1) ?? null;
  }
}

/**
 * One JSONL file per session. Writes are serialized per session and synced
 * before append resolves. The implementation never rewrites an event file.
 */
export class JsonlJournalStore implements JournalStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(readonly rootDirectory: string) {}

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    let result: JournalEvent<TData> | undefined;
    await this.exclusive(sessionId, async () => {
      const events = await this.read(sessionId);
      const head = events.at(-1) ?? null;
      assertExpectedHead(head, options);
      const event = buildEvent(sessionId, head, input);
      const path = this.eventPath(sessionId);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, 'a');
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      result = event;
    });
    return result!;
  }

  async read(sessionId: string, options?: JournalReadOptions): Promise<JournalEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.eventPath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const events = contents
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as JournalEvent;
        } catch (error) {
          throw new Error(`invalid journal JSON at ${this.eventPath(sessionId)}:${index + 1}`, {
            cause: error,
          });
        }
      });
    validateChain(sessionId, events);
    return select(events, options);
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    return (await this.read(sessionId)).at(-1) ?? null;
  }

  private eventPath(sessionId: string): string {
    return join(this.rootDirectory, encodeURIComponent(sessionId), 'events.jsonl');
  }

  private async exclusive(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const prior = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.queues.set(sessionId, tail);
    await prior;
    try {
      await operation();
    } finally {
      release();
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    }
  }
}

export function validateChain(sessionId: string, events: JournalEvent[]): void {
  let parentId: string | null = null;
  let sequence = 1;
  for (const event of events) {
    if (event.sessionId !== sessionId) throw new Error(`foreign event ${event.id} in ${sessionId}`);
    if (event.sequence !== sequence) throw new Error(`non-contiguous sequence at ${event.id}`);
    if (event.parentId !== parentId) throw new Error(`broken parent chain at ${event.id}`);
    parentId = event.id;
    sequence += 1;
  }
}
