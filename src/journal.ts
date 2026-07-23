import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createId, nowIso } from "./ids.js";
import { assertJsonSerializable, cloneJson } from "./json.js";
import { storageKey } from "./storage.js";
import type { AppendEventInput, JournalEvent } from "./protocol.js";

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
  read(
    sessionId: string,
    options?: JournalReadOptions,
  ): Promise<JournalEvent[]>;
  head(sessionId: string): Promise<JournalEvent | null>;
}

export class JournalConflictError extends Error {
  constructor(
    readonly expectedHeadId: string | null,
    readonly actualHeadId: string | null,
  ) {
    super(
      `journal head conflict: expected ${expectedHeadId ?? "<empty>"}, got ${actualHeadId ?? "<empty>"}`,
    );
    this.name = "JournalConflictError";
  }
}

function select(
  events: JournalEvent[],
  options?: JournalReadOptions,
): JournalEvent[] {
  const after = options?.afterSequence ?? 0;
  const through = options?.throughSequence ?? Number.MAX_SAFE_INTEGER;
  return events.filter(
    (event) => event.sequence > after && event.sequence <= through,
  );
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("session id must not be empty");
  }
}

function buildEvent<TData>(
  sessionId: string,
  head: JournalEvent | null,
  input: AppendEventInput<TData>,
): JournalEvent<TData> {
  assertSessionId(sessionId);
  const event = {
    id: createId("evt"),
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
  assertJsonSerializable(event);
  assertValidEnvelope(event);
  return event;
}

function assertExpectedHead(
  head: JournalEvent | null,
  options?: AppendOptions,
): void {
  if (
    options === undefined ||
    !Object.prototype.hasOwnProperty.call(options, "expectedHeadId")
  )
    return;
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
    const stored = cloneJson(event);
    events.push(stored as JournalEvent);
    this.sessions.set(sessionId, events);
    return cloneJson(stored);
  }

  async read(
    sessionId: string,
    options?: JournalReadOptions,
  ): Promise<JournalEvent[]> {
    assertSessionId(sessionId);
    return cloneJson(select(this.sessions.get(sessionId) ?? [], options));
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    assertSessionId(sessionId);
    const head = this.sessions.get(sessionId)?.at(-1);
    return head === undefined ? null : cloneJson(head);
  }
}

/**
 * One JSONL file per session. Writes are serialized per store instance and
 * synced before append resolves. Use one instance per directory; distributed
 * or multi-process writers require a transactional JournalStore implementation.
 * The implementation never rewrites an event file.
 */
export class JsonlJournalStore implements JournalStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(readonly rootDirectory: string) {}

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    const stableInput = cloneJson(input);
    let result: JournalEvent<TData> | undefined;
    await this.exclusive(sessionId, async () => {
      const events = await this.read(sessionId);
      const head = events.at(-1) ?? null;
      assertExpectedHead(head, options);
      const event = buildEvent(sessionId, head, stableInput);
      const path = this.eventPath(sessionId);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      result = event;
    });
    return result!;
  }

  async read(
    sessionId: string,
    options?: JournalReadOptions,
  ): Promise<JournalEvent[]> {
    assertSessionId(sessionId);
    let contents: string;
    try {
      contents = await readFile(this.eventPath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const events = contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as JournalEvent;
        } catch (error) {
          throw new Error(
            `invalid journal JSON at ${this.eventPath(sessionId)}:${index + 1}`,
            {
              cause: error,
            },
          );
        }
      });
    validateChain(sessionId, events);
    return select(events, options);
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    assertSessionId(sessionId);
    return (await this.read(sessionId)).at(-1) ?? null;
  }

  private eventPath(sessionId: string): string {
    return join(
      this.rootDirectory,
      storageKey(sessionId, "session id"),
      "events.jsonl",
    );
  }

  private async exclusive(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
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

export interface ValidateChainOptions {
  /** Parent immediately preceding the supplied segment. */
  parentId?: string | null;
  /** Sequence number expected for the first supplied event. */
  startingSequence?: number;
}

export function validateChain(
  sessionId: string,
  events: JournalEvent[],
  options: ValidateChainOptions = {},
): void {
  let parentId = options.parentId ?? null;
  let sequence = options.startingSequence ?? 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new TypeError("starting sequence must be a positive safe integer");
  if (
    parentId !== null &&
    (typeof parentId !== "string" || parentId.length === 0)
  ) {
    throw new TypeError("segment parent id is invalid");
  }
  const ids = new Set<string>();
  for (const event of events) {
    assertValidEnvelope(event);
    if (event.sessionId !== sessionId)
      throw new Error(`foreign event ${event.id} in ${sessionId}`);
    if (event.sequence !== sequence)
      throw new Error(`non-contiguous sequence at ${event.id}`);
    if (event.parentId !== parentId)
      throw new Error(`broken parent chain at ${event.id}`);
    if (ids.has(event.id)) throw new Error(`duplicate event id ${event.id}`);
    ids.add(event.id);
    parentId = event.id;
    sequence += 1;
  }
}

function assertValidEnvelope(event: JournalEvent<unknown>): void {
  if (typeof event.id !== "string" || event.id.length === 0)
    throw new Error("event id is invalid");
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
    throw new Error(`event ${event.id} has an invalid session id`);
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error(`event ${event.id} has an invalid sequence`);
  }
  if (
    event.parentId !== null &&
    (typeof event.parentId !== "string" || event.parentId.length === 0)
  ) {
    throw new Error(`event ${event.id} has an invalid parent`);
  }
  if (
    typeof event.timestamp !== "string" ||
    Number.isNaN(Date.parse(event.timestamp))
  ) {
    throw new Error(`event ${event.id} has an invalid timestamp`);
  }
  if (!["context", "trace", "control"].includes(event.category)) {
    throw new Error(`event ${event.id} has an invalid category`);
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    throw new Error(`event ${event.id} has an invalid type`);
  }
  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    throw new Error(`event ${event.id} has an invalid version`);
  }
  if (event.turnId !== null && typeof event.turnId !== "string") {
    throw new Error(`event ${event.id} has an invalid turn id`);
  }
  if (typeof event.affectsContext !== "boolean") {
    throw new Error(`event ${event.id} has an invalid context flag`);
  }
  assertJsonSerializable(event.data, `event ${event.id}.data`);
}
