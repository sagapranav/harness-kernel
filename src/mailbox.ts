import { assertArtifactRef } from "./artifacts.js";
import { assertJsonSerializable, cloneJson, jsonEqual } from "./json.js";
import { type JournalStore, validateChain } from "./journal.js";
import { EVENT_TYPES } from "./projection.js";
import type {
  AppendEventInput,
  CanonicalMessage,
  ChildResult,
  FileBlock,
  ImageBlock,
  JournalEvent,
  TextBlock,
} from "./protocol.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import { assertChildResult } from "./sessions.js";
import type { StorageComponentProfile } from "./storage.js";

/** Mail is an observation, never a system instruction or executable tool call. */
export type MailboxContentBlock = TextBlock | ImageBlock | FileBlock;

export interface MailboxMessage {
  /** Stable across send retries; unique across this mailbox store. */
  id: string;
  senderSessionId: string;
  recipientSessionId: string;
  createdAt: string;
  body:
    | { type: "message"; content: MailboxContentBlock[] }
    | { type: "child_result"; result: ChildResult };
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface MailboxDelivery {
  sessionId: string;
  eventId: string;
  sequence: number;
  /** Timestamp of the journal event, not the acknowledgement attempt. */
  deliveredAt: string;
}

export interface MailboxRecord {
  message: MailboxMessage;
  /** Store-wide acceptance order; unrelated to timestamps or journal sequence. */
  sequence: number;
  acceptedAt: string;
  status: "pending" | "delivered";
  delivery?: MailboxDelivery;
}

export interface MailboxReadOptions {
  afterSequence?: number;
  status?: "pending" | "delivered";
  limit?: number;
}

/**
 * Bidirectional durable-message contract. Atomic send and acknowledge, immutable
 * envelopes, increasing acceptance sequences, and defensive copies are required.
 * Acknowledgement is trusted recipient-side bookkeeping, not proof of reading.
 * Authorization, retention, scheduling, and transport notifications are host policy.
 */
export interface MailboxStore {
  readonly profile: StorageComponentProfile;
  send(message: MailboxMessage): Promise<MailboxRecord>;
  get(messageId: string): Promise<MailboxRecord | null>;
  read(
    recipientSessionId: string,
    options?: MailboxReadOptions,
  ): Promise<MailboxRecord[]>;
  /** Call only after the referenced recipient journal event is committed. */
  acknowledge(
    messageId: string,
    delivery: MailboxDelivery,
  ): Promise<MailboxRecord>;
  /** Recovery scan for schedulers; notifications alone must not drive delivery. */
  pendingRecipients(): Promise<string[]>;
}

export class MailboxConflictError extends Error {
  constructor(
    readonly messageId: string,
    reason = "immutable message conflict",
  ) {
    super(`${reason}: ${messageId}`);
    this.name = "MailboxConflictError";
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-compatible timestamp`);
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function assertMailboxMessage(message: MailboxMessage): void {
  assertJsonSerializable(message);
  nonEmpty(message.id, "mailbox message id");
  nonEmpty(message.senderSessionId, "mailbox sender");
  nonEmpty(message.recipientSessionId, "mailbox recipient");
  timestamp(message.createdAt, "mailbox createdAt");
  if (message.replyToMessageId !== undefined)
    nonEmpty(message.replyToMessageId, "reply id");
  if (message.body?.type === "child_result") {
    assertChildResult(message.body.result);
    if (message.body.result.childSessionId !== message.senderSessionId) {
      throw new TypeError("child result must identify its sender session");
    }
  } else if (message.body?.type === "message") {
    if (
      !Array.isArray(message.body.content) ||
      message.body.content.length === 0
    ) {
      throw new TypeError("mailbox message content must be a non-empty array");
    }
    for (const block of message.body.content) {
      if (block?.type === "text") {
        if (typeof block.text !== "string")
          throw new TypeError("mail text must be a string");
      } else if (block?.type === "image" || block?.type === "file") {
        assertArtifactRef(block.artifact);
      } else {
        throw new TypeError(
          "mail accepts only text, image, and file observations",
        );
      }
    }
  } else {
    throw new TypeError("mailbox body type is invalid");
  }
}

export function assertMailboxDelivery(delivery: MailboxDelivery): void {
  assertJsonSerializable(delivery);
  nonEmpty(delivery.sessionId, "delivery session");
  nonEmpty(delivery.eventId, "delivery event");
  positiveInteger(delivery.sequence, "delivery sequence");
  timestamp(delivery.deliveredAt, "delivery timestamp");
}

export function assertMailboxReadOptions(options: MailboxReadOptions): void {
  if (
    options.afterSequence !== undefined &&
    (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
  ) {
    throw new TypeError("mailbox cursor must be a non-negative safe integer");
  }
  if (options.limit !== undefined)
    positiveInteger(options.limit, "mailbox limit");
  if (
    options.status !== undefined &&
    !["pending", "delivered"].includes(options.status)
  ) {
    throw new TypeError("mailbox status is invalid");
  }
}

/** Versioned adapter snapshot, including deliveries and the acceptance sequence. */
export interface MailboxSnapshot {
  version: 1;
  records: MailboxRecord[];
}

export function assertMailboxSnapshot(snapshot: MailboxSnapshot): void {
  assertJsonSerializable(snapshot);
  if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
    throw new TypeError("unsupported mailbox snapshot");
  }
  const ids = new Set<string>();
  for (const [index, record] of snapshot.records.entries()) {
    assertMailboxMessage(record.message);
    timestamp(record.acceptedAt, "mailbox acceptedAt");
    if (record.sequence !== index + 1 || ids.has(record.message.id)) {
      throw new TypeError(
        "mailbox snapshot has duplicate IDs or a broken sequence",
      );
    }
    ids.add(record.message.id);
    if (record.status === "delivered" && record.delivery !== undefined) {
      assertMailboxDelivery(record.delivery);
      if (record.delivery.sessionId !== record.message.recipientSessionId) {
        throw new TypeError("mailbox delivery belongs to another recipient");
      }
    } else if (record.status !== "pending" || record.delivery !== undefined) {
      throw new TypeError("mailbox status does not match its delivery");
    }
  }
}

/** Ephemeral, single-instance reference implementation. */
export class MemoryMailboxStore implements MailboxStore {
  readonly profile: StorageComponentProfile = {
    adapter: "MemoryMailboxStore",
    durability: "ephemeral",
    coordination: "single_instance",
  };
  private readonly records = new Map<string, MailboxRecord>();

  constructor(
    readonly runtime: RuntimeServices = defaultRuntime,
    snapshot?: MailboxSnapshot,
  ) {
    if (snapshot !== undefined) {
      assertMailboxSnapshot(snapshot);
      for (const record of cloneJson(snapshot).records)
        this.records.set(record.message.id, record);
    }
  }

  snapshot(): MailboxSnapshot {
    return { version: 1, records: cloneJson([...this.records.values()]) };
  }

  async send(message: MailboxMessage): Promise<MailboxRecord> {
    assertMailboxMessage(message);
    const prior = this.records.get(message.id);
    if (prior !== undefined) {
      if (!jsonEqual(prior.message, message))
        throw new MailboxConflictError(message.id);
      return cloneJson(prior);
    }
    const acceptedAt = this.runtime.nowIso();
    timestamp(acceptedAt, "mailbox acceptedAt");
    const sequence = this.records.size + 1;
    positiveInteger(sequence, "mailbox sequence");
    const record: MailboxRecord = {
      message: cloneJson(message),
      sequence,
      acceptedAt,
      status: "pending",
    };
    this.records.set(message.id, record);
    return cloneJson(record);
  }

  async get(messageId: string): Promise<MailboxRecord | null> {
    nonEmpty(messageId, "mailbox message id");
    return cloneJson(this.records.get(messageId) ?? null);
  }

  async read(
    recipientSessionId: string,
    options: MailboxReadOptions = {},
  ): Promise<MailboxRecord[]> {
    nonEmpty(recipientSessionId, "mailbox recipient");
    assertMailboxReadOptions(options);
    return cloneJson(
      [...this.records.values()]
        .filter(
          (record) =>
            record.message.recipientSessionId === recipientSessionId &&
            record.sequence > (options.afterSequence ?? 0) &&
            (options.status === undefined || record.status === options.status),
        )
        .slice(0, options.limit),
    );
  }

  async acknowledge(
    messageId: string,
    delivery: MailboxDelivery,
  ): Promise<MailboxRecord> {
    nonEmpty(messageId, "mailbox message id");
    assertMailboxDelivery(delivery);
    const record = this.records.get(messageId);
    if (record === undefined)
      throw new Error(`mailbox message not found: ${messageId}`);
    if (record.message.recipientSessionId !== delivery.sessionId) {
      throw new MailboxConflictError(messageId, "wrong delivery recipient");
    }
    if (
      record.delivery !== undefined &&
      !jsonEqual(record.delivery, delivery)
    ) {
      throw new MailboxConflictError(
        messageId,
        "conflicting delivery acknowledgement",
      );
    }
    record.delivery = cloneJson(delivery);
    record.status = "delivered";
    return cloneJson(record);
  }

  async pendingRecipients(): Promise<string[]> {
    return [
      ...new Set(
        [...this.records.values()]
          .filter((r) => r.status === "pending")
          .map((r) => r.message.recipientSessionId),
      ),
    ];
  }
}

/** Creates a context observation with its full immutable delivery envelope. */
export function mailboxEvent(message: MailboxMessage): AppendEventInput {
  assertMailboxMessage(message);
  const stable = cloneJson(message);
  const result =
    stable.body.type === "child_result" ? stable.body.result : undefined;
  const observation: CanonicalMessage = {
    id: `mail:${stable.id}`,
    role: "user",
    createdAt: stable.createdAt,
    content:
      stable.body.type === "message"
        ? [...stable.body.content]
        : [
            {
              type: "text",
              text:
                result!.conclusion ??
                (result!.noneFound === true
                  ? `Child ${result!.childSessionId} found no relevant evidence.`
                  : `Child ${result!.childSessionId} returned without a conclusion.`),
            },
          ],
    metadata: {
      mailboxMessageId: stable.id,
      senderSessionId: stable.senderSessionId,
      ...(result === undefined
        ? {}
        : {
            childSessionId: result.childSessionId,
            status: result.status,
            noneFound: result.noneFound ?? false,
            evidenceRefs: result.evidenceRefs,
            artifactRefs: result.artifactRefs,
            ...(result.confidence === undefined
              ? {}
              : { confidence: result.confidence }),
          }),
    },
  };
  // Provider encoders need not transmit canonical metadata. Keep routing
  // provenance visible to the model as an observation, never a system role.
  observation.content.unshift({
    type: "text",
    text: `Mailbox observation ${JSON.stringify({
      messageId: stable.id,
      senderSessionId: stable.senderSessionId,
      ...(stable.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: stable.replyToMessageId }),
    })}`,
  });
  return {
    category: "context",
    type:
      result === undefined
        ? EVENT_TYPES.mailboxMessageReceived
        : EVENT_TYPES.childCompleted,
    affectsContext: true,
    data: {
      mailboxMessage: stable,
      message: observation,
      ...(result === undefined ? {} : { result }),
    },
  };
}

export interface ReceiveMailboxOptions {
  sessionId: string;
  mailbox: MailboxStore;
  journal: JournalStore;
  /** Finite batch so continuous senders cannot starve the next model turn. Default 100. */
  maxMessages?: number;
  /**
   * Recipient owner's tracked writer. The agent loop supplies its own appender.
   * Omit only between loop executions; the default uses expected-head appends.
   */
  append?: (input: AppendEventInput) => Promise<JournalEvent>;
}

export interface MailboxReceiveResult {
  appended: number;
  acknowledged: number;
  deliveries: MailboxDelivery[];
}

function eventData(event: JournalEvent): Record<string, unknown> {
  return typeof event.data === "object" && event.data !== null
    ? (event.data as Record<string, unknown>)
    : {};
}

/**
 * Recipient-owned append-before-ack handoff across independent stores. Recovery
 * scans raw history, including compacted messages, to close a lost-ack window.
 * Concurrent receivers must share session fencing; this function is not a lease.
 */
export async function receiveMailbox(
  options: ReceiveMailboxOptions,
): Promise<MailboxReceiveResult> {
  const limit = options.maxMessages ?? 100;
  positiveInteger(limit, "mailbox receive limit");
  const batch = await options.mailbox.read(options.sessionId, {
    status: "pending",
    limit,
  });
  const result: MailboxReceiveResult = {
    appended: 0,
    acknowledged: 0,
    deliveries: [],
  };
  if (batch.length === 0) return result;
  const events = await options.journal.read(options.sessionId);
  validateChain(options.sessionId, events);
  let headId = events.at(-1)?.id ?? null;
  const append =
    options.append ??
    (async (input: AppendEventInput) => {
      const event = await options.journal.append(options.sessionId, input, {
        expectedHeadId: headId,
      });
      headId = event.id;
      return event;
    });
  for (const record of batch) {
    const message = record.message;
    assertMailboxMessage(message);
    if (message.recipientSessionId !== options.sessionId) {
      throw new MailboxConflictError(
        message.id,
        "mailbox returned another recipient's message",
      );
    }
    let existing = events.find((event) => {
      const mail = eventData(event).mailboxMessage as
        Partial<MailboxMessage> | undefined;
      return mail?.id === message.id;
    });
    if (existing !== undefined) {
      const expected = mailboxEvent(message);
      if (
        existing.type !== expected.type ||
        existing.category !== expected.category ||
        existing.affectsContext !== true ||
        !jsonEqual(existing.data, expected.data)
      ) {
        throw new MailboxConflictError(
          message.id,
          "journal envelope conflicts with mailbox",
        );
      }
    }
    if (existing === undefined && message.body.type === "child_result") {
      const childResult = message.body.result;
      existing = events.find(
        (event) =>
          event.type === EVENT_TYPES.childCompleted &&
          (eventData(event).result as Partial<ChildResult> | undefined)
            ?.childSessionId === childResult.childSessionId,
      );
      if (
        existing !== undefined &&
        !jsonEqual(eventData(existing).result, childResult)
      ) {
        throw new MailboxConflictError(
          message.id,
          "conflicting child completion",
        );
      }
    }
    if (existing === undefined) {
      existing = await append(mailboxEvent(message));
      events.push(existing);
      result.appended += 1;
    }
    const delivery: MailboxDelivery = {
      sessionId: options.sessionId,
      eventId: existing.id,
      sequence: existing.sequence,
      deliveredAt: existing.timestamp,
    };
    await options.mailbox.acknowledge(message.id, delivery);
    result.acknowledged += 1;
    result.deliveries.push(delivery);
  }
  return result;
}

export interface WaitForMailboxOptions {
  /** Bounded wait; default 30 seconds. Zero performs one immediate check. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type MailboxWaitResult =
  | { status: "available"; records: MailboxRecord[] }
  | { status: "timeout" }
  | { status: "cancelled" };

/**
 * Wait for pending mail using durable reads, including mail that arrived before
 * waiting. Does not acknowledge, run a model, or persist a wait registration.
 * Hosts reissue waits after restart; pendingRecipients supports scheduler recovery.
 */
export async function waitForMailbox(
  mailbox: MailboxStore,
  recipientSessionId: string,
  options: WaitForMailboxOptions = {},
): Promise<MailboxWaitResult> {
  nonEmpty(recipientSessionId, "mailbox recipient");
  const timeout = options.timeoutMs ?? 30_000;
  const interval = options.pollIntervalMs ?? 250;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 0 ||
    timeout > 2_147_483_647
  ) {
    throw new TypeError(
      "mailbox timeout must be between 0 and 2147483647 milliseconds",
    );
  }
  positiveInteger(interval, "mailbox poll interval");
  const deadline = performance.now() + timeout;
  for (;;) {
    if (options.signal?.aborted === true) return { status: "cancelled" };
    const records = await mailbox.read(recipientSessionId, {
      status: "pending",
      limit: 100,
    });
    if (aborted(options.signal)) return { status: "cancelled" };
    if (records.length > 0) return { status: "available", records };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: "timeout" };
    await pause(Math.min(interval, remaining), options.signal);
  }
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted === true) finish();
  });
}
