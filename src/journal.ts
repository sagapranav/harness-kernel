import { assertJsonSerializable, cloneJson } from "./json.js";
import type { AppendEventInput, JournalEvent } from "./protocol.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";

export interface JournalReadOptions {
  afterSequence?: number;
  throughSequence?: number;
}

export interface AppendOptions {
  /** Optimistic-concurrency guard. `null` means the journal must be empty. */
  expectedHeadId?: string | null;
}

export interface JournalStore {
  /**
   * Atomically append against one session head. Implementations must honor
   * expectedHeadId in the same transaction as the append.
   */
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

export function selectJournalEvents(
  events: JournalEvent[],
  options?: JournalReadOptions,
): JournalEvent[] {
  const after = options?.afterSequence ?? 0;
  const through = options?.throughSequence ?? Number.MAX_SAFE_INTEGER;
  return events.filter(
    (event) => event.sequence > after && event.sequence <= through,
  );
}

export function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("session id must not be empty");
  }
}

export function createJournalEvent<TData>(
  sessionId: string,
  head: JournalEvent | null,
  input: AppendEventInput<TData>,
  runtime: RuntimeServices = defaultRuntime,
): JournalEvent<TData> {
  assertSessionId(sessionId);
  const event = {
    id: runtime.createId("evt"),
    sessionId,
    sequence: (head?.sequence ?? 0) + 1,
    parentId: head?.id ?? null,
    timestamp: runtime.nowIso(),
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

export function assertExpectedJournalHead(
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

  constructor(readonly runtime: RuntimeServices = defaultRuntime) {}

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    const events = this.sessions.get(sessionId) ?? [];
    const head = events.at(-1) ?? null;
    assertExpectedJournalHead(head, options);
    const event = createJournalEvent(sessionId, head, input, this.runtime);
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
    return cloneJson(
      selectJournalEvents(this.sessions.get(sessionId) ?? [], options),
    );
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    assertSessionId(sessionId);
    const head = this.sessions.get(sessionId)?.at(-1);
    return head === undefined ? null : cloneJson(head);
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
