import { assertArtifactRef } from "./artifacts.js";
import { assertJsonSerializable, cloneJson, jsonEqual } from "./json.js";
import { JournalConflictError, type JournalStore } from "./journal.js";
import { EVENT_TYPES, projectContext } from "./projection.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import type {
  ChildResult,
  ContextProjection,
  ImmutableRunConfig,
  SessionDescriptor,
} from "./protocol.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function assertSessionDescriptor(session: SessionDescriptor): void {
  assertJsonSerializable(session);
  if (!nonEmpty(session.id))
    throw new TypeError("session id must not be empty");
  if (!nonEmpty(session.configId))
    throw new TypeError("session config id must not be empty");
  if (!timestamp(session.createdAt))
    throw new TypeError("session createdAt must be a timestamp");
  if (
    (session.parentSessionId === undefined) !==
    (session.forkEventId === undefined)
  ) {
    throw new TypeError(
      "child sessions require both parentSessionId and forkEventId",
    );
  }
  if (
    session.parentSessionId !== undefined &&
    !nonEmpty(session.parentSessionId)
  ) {
    throw new TypeError("parent session id must not be empty");
  }
  if (session.forkEventId !== undefined && !nonEmpty(session.forkEventId))
    throw new TypeError("fork event id must not be empty");
  if (session.purpose !== undefined && typeof session.purpose !== "string")
    throw new TypeError("session purpose must be a string");
}

export function assertRunConfig(config: ImmutableRunConfig): void {
  assertJsonSerializable(config);
  if (!nonEmpty(config.id)) throw new TypeError("config id must not be empty");
  if (!Number.isSafeInteger(config.version) || config.version < 1)
    throw new TypeError("config version must be a positive safe integer");
  if (!timestamp(config.createdAt))
    throw new TypeError("config createdAt must be a timestamp");
  if (!nonEmpty(config.provider?.provider))
    throw new TypeError("config provider must not be empty");
  if (!nonEmpty(config.provider.model))
    throw new TypeError("config model must not be empty");
  if (
    config.provider.endpoint !== undefined &&
    typeof config.provider.endpoint !== "string"
  ) {
    throw new TypeError("config provider endpoint must be a string");
  }
  if (!Array.isArray(config.tools))
    throw new TypeError("config tools must be an array");
  const names = new Set<string>();
  for (const tool of config.tools) {
    if (!nonEmpty(tool?.name))
      throw new TypeError("tool names must not be empty");
    if (names.has(tool.name))
      throw new TypeError(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== "string")
      throw new TypeError(`tool ${tool.name} description must be a string`);
    if (
      typeof tool.inputSchema !== "object" ||
      tool.inputSchema === null ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new TypeError(`tool ${tool.name} input schema must be an object`);
    }
  }
  if (
    config.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(config.maxOutputTokens) ||
      config.maxOutputTokens < 1)
  ) {
    throw new TypeError("maxOutputTokens must be a positive safe integer");
  }
  if (
    config.temperature !== undefined &&
    (typeof config.temperature !== "number" ||
      !Number.isFinite(config.temperature))
  ) {
    throw new TypeError("temperature must be a finite number");
  }
}

export function assertChildResult(result: ChildResult): void {
  assertJsonSerializable(result);
  if (!nonEmpty(result.childSessionId))
    throw new TypeError("child session id must not be empty");
  if (!["completed", "failed", "cancelled"].includes(result.status))
    throw new TypeError("child status is invalid");
  if (
    result.conclusion !== undefined &&
    typeof result.conclusion !== "string"
  ) {
    throw new TypeError("child conclusion must be a string");
  }
  if (result.noneFound !== undefined && typeof result.noneFound !== "boolean")
    throw new TypeError("child noneFound must be a boolean");
  if (
    result.confidence !== undefined &&
    (!Number.isFinite(result.confidence) ||
      result.confidence < 0 ||
      result.confidence > 1)
  ) {
    throw new TypeError("child confidence must be between 0 and 1");
  }
  for (const [label, refs] of [
    ["evidenceRefs", result.evidenceRefs],
    ["artifactRefs", result.artifactRefs],
  ] as const) {
    if (!Array.isArray(refs))
      throw new TypeError(`child ${label} must be an array`);
    for (const ref of refs) assertArtifactRef(ref);
  }
}

export interface SessionCatalog {
  /** Descriptors and configs are immutable: identical puts are idempotent. */
  putSession(session: SessionDescriptor): Promise<void>;
  getSession(sessionId: string): Promise<SessionDescriptor | null>;
  putConfig(config: ImmutableRunConfig): Promise<void>;
  getConfig(configId: string): Promise<ImmutableRunConfig | null>;
}

export class MemorySessionCatalog implements SessionCatalog {
  private readonly sessions = new Map<string, SessionDescriptor>();
  private readonly configs = new Map<string, ImmutableRunConfig>();

  async putSession(session: SessionDescriptor): Promise<void> {
    assertSessionDescriptor(session);
    const existing = this.sessions.get(session.id);
    if (existing !== undefined) {
      if (!jsonEqual(existing, session)) {
        throw new Error(`immutable session conflict: ${session.id}`);
      }
      return;
    }
    this.sessions.set(session.id, cloneJson(session));
  }

  async getSession(sessionId: string): Promise<SessionDescriptor | null> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : cloneJson(session);
  }

  async putConfig(config: ImmutableRunConfig): Promise<void> {
    assertRunConfig(config);
    const existing = this.configs.get(config.id);
    if (existing !== undefined && !jsonEqual(existing, config)) {
      throw new Error(`immutable config conflict: ${config.id}`);
    }
    this.configs.set(config.id, cloneJson(config));
  }

  async getConfig(configId: string): Promise<ImmutableRunConfig | null> {
    const config = this.configs.get(configId);
    return config === undefined ? null : cloneJson(config);
  }
}

export interface CreateSessionOptions {
  id?: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkSessionOptions extends CreateSessionOptions {
  atEventId?: string;
}

/**
 * Session lifecycle and fork semantics. A child owns an independent raw
 * journal. Its inherited parent context is resolved as a projection at the
 * immutable fork event.
 */
export class SessionManager {
  constructor(
    readonly journal: JournalStore,
    readonly catalog: SessionCatalog,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {}

  async create(
    config: ImmutableRunConfig,
    options: CreateSessionOptions = {},
  ): Promise<SessionDescriptor> {
    await this.catalog.putConfig(config);
    const session: SessionDescriptor = {
      id: options.id ?? this.runtime.createId("session"),
      configId: config.id,
      createdAt: this.runtime.nowIso(),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
    await this.catalog.putSession(session);
    await this.journal.append(
      session.id,
      {
        category: "control",
        type: EVENT_TYPES.sessionStarted,
        data: { session },
      },
      { expectedHeadId: null },
    );
    return session;
  }

  async fork(
    parentSessionId: string,
    config: ImmutableRunConfig,
    options: ForkSessionOptions = {},
  ): Promise<SessionDescriptor> {
    const parent = await this.requireSession(parentSessionId);
    const parentEvents = await this.journal.read(parent.id);
    const forkEvent =
      options.atEventId === undefined
        ? parentEvents.at(-1)
        : parentEvents.find((event) => event.id === options.atEventId);
    if (forkEvent === undefined)
      throw new Error(`fork event not found in ${parent.id}`);

    await this.catalog.putConfig(config);
    const child: SessionDescriptor = {
      id: options.id ?? this.runtime.createId("session"),
      configId: config.id,
      createdAt: this.runtime.nowIso(),
      parentSessionId: parent.id,
      forkEventId: forkEvent.id,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
    await this.catalog.putSession(child);
    await this.journal.append(
      child.id,
      {
        category: "control",
        type: EVENT_TYPES.sessionStarted,
        data: { session: child },
      },
      { expectedHeadId: null },
    );
    await this.journal.append(parent.id, {
      category: "trace",
      type: EVENT_TYPES.childStarted,
      data: {
        childSessionId: child.id,
        forkEventId: forkEvent.id,
        configId: config.id,
        ...(child.purpose === undefined ? {} : { purpose: child.purpose }),
      },
    });
    return child;
  }

  async completeChild(
    parentSessionId: string,
    result: ChildResult,
  ): Promise<void> {
    assertChildResult(result);
    const child = await this.requireSession(result.childSessionId);
    if (child.parentSessionId !== parentSessionId) {
      throw new Error(`${child.id} is not a child of ${parentSessionId}`);
    }
    for (;;) {
      const parentEvents = await this.journal.read(parentSessionId);
      const prior = parentEvents.find((event) => {
        if (event.type !== EVENT_TYPES.childCompleted) return false;
        const data =
          typeof event.data === "object" && event.data !== null
            ? (event.data as Record<string, unknown>)
            : {};
        const priorResult =
          typeof data.result === "object" && data.result !== null
            ? (data.result as Partial<ChildResult>)
            : {};
        return priorResult.childSessionId === result.childSessionId;
      });
      if (prior !== undefined) {
        const priorResult = (prior.data as { result: ChildResult }).result;
        if (jsonEqual(priorResult, result)) return;
        throw new Error(`child completion conflict: ${result.childSessionId}`);
      }

      const headId = parentEvents.at(-1)?.id ?? null;
      try {
        await this.journal.append(
          parentSessionId,
          {
            category: "context",
            type: EVENT_TYPES.childCompleted,
            affectsContext: true,
            data: {
              result,
              message: {
                id: this.runtime.createId("msg"),
                role: "user",
                createdAt: this.runtime.nowIso(),
                content: [
                  {
                    type: "text",
                    text:
                      result.conclusion ??
                      (result.noneFound === true
                        ? `Child ${result.childSessionId} found no relevant evidence.`
                        : `Child ${result.childSessionId} returned without a conclusion.`),
                  },
                ],
                metadata: {
                  childSessionId: result.childSessionId,
                  status: result.status,
                  ...(result.confidence === undefined
                    ? {}
                    : { confidence: result.confidence }),
                  noneFound: result.noneFound ?? false,
                  evidenceRefs: result.evidenceRefs,
                  artifactRefs: result.artifactRefs,
                },
              },
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

  async project(sessionId: string): Promise<ContextProjection> {
    return this.projectRecursive(sessionId, new Set());
  }

  private async projectRecursive(
    sessionId: string,
    visited: Set<string>,
  ): Promise<ContextProjection> {
    if (visited.has(sessionId))
      throw new Error(`session ancestry cycle at ${sessionId}`);
    visited.add(sessionId);
    const session = await this.requireSession(sessionId);
    const events = await this.journal.read(session.id);

    if (
      session.parentSessionId === undefined ||
      session.forkEventId === undefined
    ) {
      return projectContext(session.id, events);
    }

    const parent = await this.requireSession(session.parentSessionId);
    const parentEvents = await this.journal.read(parent.id);
    const fork = parentEvents.find((event) => event.id === session.forkEventId);
    if (fork === undefined)
      throw new Error(`missing fork event ${session.forkEventId}`);
    const inherited = await this.projectAt(parent, fork.sequence, visited);
    return projectContext(session.id, events, {
      inheritedMessages: inherited.messages,
      inheritedEvidenceRefs: inherited.evidenceRefs,
    });
  }

  private async projectAt(
    session: SessionDescriptor,
    throughSequence: number,
    visited: Set<string>,
  ): Promise<ContextProjection> {
    const events = await this.journal.read(session.id, { throughSequence });
    if (
      session.parentSessionId === undefined ||
      session.forkEventId === undefined
    ) {
      return projectContext(session.id, events);
    }
    if (visited.has(session.parentSessionId)) {
      throw new Error(`session ancestry cycle at ${session.parentSessionId}`);
    }
    visited.add(session.parentSessionId);
    const parent = await this.requireSession(session.parentSessionId);
    const parentEvents = await this.journal.read(parent.id);
    const fork = parentEvents.find((event) => event.id === session.forkEventId);
    if (fork === undefined)
      throw new Error(`missing fork event ${session.forkEventId}`);
    const inherited = await this.projectAt(parent, fork.sequence, visited);
    return projectContext(session.id, events, {
      inheritedMessages: inherited.messages,
      inheritedEvidenceRefs: inherited.evidenceRefs,
    });
  }

  private async requireSession(sessionId: string): Promise<SessionDescriptor> {
    const session = await this.catalog.getSession(sessionId);
    if (session === null) throw new Error(`session not found: ${sessionId}`);
    return session;
  }
}
