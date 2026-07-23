import { JournalConflictError } from "./journal.js";
import { jsonEqual } from "./json.js";
import { EVENT_TYPES } from "./projection.js";
import type {
  ImmutableRunConfig,
  JournalEvent,
  SessionDescriptor,
} from "./protocol.js";
import {
  assertSessionDescriptor,
  type ForkSessionOptions,
  SessionManager,
} from "./sessions.js";
import {
  type WorkDeliveryPolicy,
  type WorkItem,
  type WorkQueue,
  type WorkRecord,
} from "./work.js";

export const DEFAULT_AGENT_WORK_POLICY: Readonly<WorkDeliveryPolicy> =
  Object.freeze({
    maxAttempts: 3,
    maxContinuations: 12,
  });

export interface SessionRunPayload {
  configId: string;
  parentSessionId?: string;
  purpose?: string;
  input?: unknown;
}

export interface SessionRunWorkOptions {
  workId?: string;
  kind?: string;
  requiredCapabilities?: string[];
  policy?: WorkDeliveryPolicy;
  input?: unknown;
  priority?: number;
  notBefore?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a deterministic work item for one session run. The descriptor's
 * immutable creation time and a session-derived default ID make dispatch safe
 * to retry after a process dies between session creation and queue submission.
 */
export function createSessionRunWork(
  session: SessionDescriptor,
  options: SessionRunWorkOptions = {},
): WorkItem {
  assertSessionDescriptor(session);
  const id = options.workId ?? `session:${session.id}:run`;
  const payload: SessionRunPayload = {
    configId: session.configId,
    ...(session.parentSessionId === undefined
      ? {}
      : { parentSessionId: session.parentSessionId }),
    ...(session.purpose === undefined ? {} : { purpose: session.purpose }),
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  return {
    id,
    sessionId: session.id,
    kind: options.kind ?? "agent.run",
    createdAt: session.createdAt,
    requiredCapabilities: options.requiredCapabilities ?? ["agent"],
    policy: options.policy ?? { ...DEFAULT_AGENT_WORK_POLICY },
    payload,
    idempotencyKey: id,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.notBefore === undefined
      ? {}
      : { notBefore: options.notBefore }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

export interface DispatchedSessionRun {
  session: SessionDescriptor;
  work: WorkRecord;
}

/**
 * Connects first-class child sessions to an injected execution queue.
 *
 * Claude, another model, or deterministic workflow code can call this through
 * an action adapter. Provider choice stays in each immutable run config.
 */
export class SessionWorkDispatcher {
  constructor(
    readonly sessions: SessionManager,
    readonly queue: WorkQueue,
  ) {}

  async dispatch(
    sessionId: string,
    options: SessionRunWorkOptions = {},
  ): Promise<DispatchedSessionRun> {
    const session = await this.sessions.catalog.getSession(sessionId);
    if (session === null) throw new Error(`session not found: ${sessionId}`);
    const work = await this.queue.enqueue(
      createSessionRunWork(session, options),
    );
    return { session, work };
  }

  async forkAndDispatch(
    parentSessionId: string,
    config: ImmutableRunConfig,
    forkOptions: ForkSessionOptions = {},
    workOptions: SessionRunWorkOptions = {},
  ): Promise<DispatchedSessionRun> {
    let session: SessionDescriptor;
    const existing =
      forkOptions.id === undefined
        ? null
        : await this.sessions.catalog.getSession(forkOptions.id);
    if (existing !== null) {
      session = await this.recoverFork(
        existing,
        parentSessionId,
        config,
        forkOptions,
      );
    } else {
      try {
        session = await this.sessions.fork(
          parentSessionId,
          config,
          forkOptions,
        );
      } catch (error) {
        const raced =
          forkOptions.id === undefined
            ? null
            : await this.sessions.catalog.getSession(forkOptions.id);
        if (raced === null) throw error;
        session = await this.recoverFork(
          raced,
          parentSessionId,
          config,
          forkOptions,
        );
      }
    }
    const work = await this.queue.enqueue(
      createSessionRunWork(session, workOptions),
    );
    return { session, work };
  }

  private async recoverFork(
    session: SessionDescriptor,
    parentSessionId: string,
    config: ImmutableRunConfig,
    options: ForkSessionOptions,
  ): Promise<SessionDescriptor> {
    assertSessionDescriptor(session);
    if (
      session.parentSessionId !== parentSessionId ||
      session.configId !== config.id ||
      session.purpose !== options.purpose ||
      !jsonEqual(session.metadata ?? null, options.metadata ?? null)
    ) {
      throw new Error(`existing child session conflicts: ${session.id}`);
    }
    if (
      options.atEventId !== undefined &&
      session.forkEventId !== options.atEventId
    ) {
      throw new Error(`existing child fork boundary conflicts: ${session.id}`);
    }

    await this.sessions.catalog.putConfig(config);
    const parentEvents = await this.sessions.journal.read(parentSessionId);
    if (!parentEvents.some((event) => event.id === session.forkEventId)) {
      throw new Error(
        `existing child fork event is absent from ${parentSessionId}`,
      );
    }
    await this.ensureChildStart(session);
    await this.ensureParentChildStart(parentSessionId, session);
    return session;
  }

  private async ensureChildStart(session: SessionDescriptor): Promise<void> {
    for (;;) {
      const events = await this.sessions.journal.read(session.id);
      const first = events[0];
      if (first !== undefined) {
        const recorded = this.recordedSession(first);
        if (
          first.type !== EVENT_TYPES.sessionStarted ||
          recorded === null ||
          !jsonEqual(recorded, session)
        ) {
          throw new Error(`child journal start conflicts: ${session.id}`);
        }
        return;
      }
      try {
        await this.sessions.journal.append(
          session.id,
          {
            category: "control",
            type: EVENT_TYPES.sessionStarted,
            data: { session },
          },
          { expectedHeadId: null },
        );
        return;
      } catch (error) {
        if (error instanceof JournalConflictError) continue;
        throw error;
      }
    }
  }

  private async ensureParentChildStart(
    parentSessionId: string,
    child: SessionDescriptor,
  ): Promise<void> {
    for (;;) {
      const events = await this.sessions.journal.read(parentSessionId);
      const matching = events.find((event) => {
        if (event.type !== EVENT_TYPES.childStarted) return false;
        const data = this.record(event.data);
        return data?.childSessionId === child.id;
      });
      if (matching !== undefined) {
        const data = this.record(matching.data);
        if (
          data?.forkEventId !== child.forkEventId ||
          data?.configId !== child.configId
        ) {
          throw new Error(`parent child-start conflicts: ${child.id}`);
        }
        return;
      }
      const headId = events.at(-1)?.id ?? null;
      try {
        await this.sessions.journal.append(
          parentSessionId,
          {
            category: "trace",
            type: EVENT_TYPES.childStarted,
            data: {
              childSessionId: child.id,
              forkEventId: child.forkEventId,
              configId: child.configId,
              ...(child.purpose === undefined
                ? {}
                : { purpose: child.purpose }),
            },
          },
          { expectedHeadId: headId },
        );
        return;
      } catch (error) {
        if (error instanceof JournalConflictError) continue;
        throw error;
      }
    }
  }

  private recordedSession(event: JournalEvent): SessionDescriptor | null {
    const data = this.record(event.data);
    const session = data?.session;
    return typeof session === "object" && session !== null
      ? (session as SessionDescriptor)
      : null;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
