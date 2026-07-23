import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createId, nowIso } from './ids.js';
import type { JournalStore } from './journal.js';
import { EVENT_TYPES, projectContext } from './projection.js';
import type {
  ChildResult,
  ContextProjection,
  ImmutableRunConfig,
  SessionDescriptor,
} from './protocol.js';

export interface SessionCatalog {
  putSession(session: SessionDescriptor): Promise<void>;
  getSession(sessionId: string): Promise<SessionDescriptor | null>;
  putConfig(config: ImmutableRunConfig): Promise<void>;
  getConfig(configId: string): Promise<ImmutableRunConfig | null>;
}

export class MemorySessionCatalog implements SessionCatalog {
  private readonly sessions = new Map<string, SessionDescriptor>();
  private readonly configs = new Map<string, ImmutableRunConfig>();

  async putSession(session: SessionDescriptor): Promise<void> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(session)) {
        throw new Error(`immutable session conflict: ${session.id}`);
      }
      return;
    }
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(sessionId: string): Promise<SessionDescriptor | null> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : structuredClone(session);
  }

  async putConfig(config: ImmutableRunConfig): Promise<void> {
    const existing = this.configs.get(config.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(config)) {
      throw new Error(`immutable config conflict: ${config.id}`);
    }
    this.configs.set(config.id, structuredClone(config));
  }

  async getConfig(configId: string): Promise<ImmutableRunConfig | null> {
    const config = this.configs.get(configId);
    return config === undefined ? null : structuredClone(config);
  }
}

/** Immutable JSON descriptors/configs. Journals remain in the JournalStore. */
export class FileSessionCatalog implements SessionCatalog {
  constructor(readonly rootDirectory: string) {}

  async putSession(session: SessionDescriptor): Promise<void> {
    await this.writeOnce(this.sessionPath(session.id), session);
  }

  async getSession(sessionId: string): Promise<SessionDescriptor | null> {
    return this.readJson<SessionDescriptor>(this.sessionPath(sessionId));
  }

  async putConfig(config: ImmutableRunConfig): Promise<void> {
    const existing = await this.getConfig(config.id);
    if (existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(config)) {
        throw new Error(`immutable config conflict: ${config.id}`);
      }
      return;
    }
    await this.writeOnce(this.configPath(config.id), config);
  }

  async getConfig(configId: string): Promise<ImmutableRunConfig | null> {
    return this.readJson<ImmutableRunConfig>(this.configPath(configId));
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeOnce(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${createId('catalog')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      const existing = await this.readJson<unknown>(path);
      if (existing === null) throw error;
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`immutable value conflict: ${path}`);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private sessionPath(sessionId: string): string {
    return join(this.rootDirectory, 'sessions', encodeURIComponent(sessionId), 'session.json');
  }

  private configPath(configId: string): string {
    return join(this.rootDirectory, 'configs', `${encodeURIComponent(configId)}.json`);
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
  ) {}

  async create(
    config: ImmutableRunConfig,
    options: CreateSessionOptions = {},
  ): Promise<SessionDescriptor> {
    await this.catalog.putConfig(config);
    const session: SessionDescriptor = {
      id: options.id ?? createId('session'),
      configId: config.id,
      createdAt: nowIso(),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
    await this.catalog.putSession(session);
    await this.journal.append(
      session.id,
      {
        category: 'control',
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
    if (forkEvent === undefined) throw new Error(`fork event not found in ${parent.id}`);

    await this.catalog.putConfig(config);
    const child: SessionDescriptor = {
      id: options.id ?? createId('session'),
      configId: config.id,
      createdAt: nowIso(),
      parentSessionId: parent.id,
      forkEventId: forkEvent.id,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
    await this.catalog.putSession(child);
    await this.journal.append(
      child.id,
      {
        category: 'control',
        type: EVENT_TYPES.sessionStarted,
        data: { session: child },
      },
      { expectedHeadId: null },
    );
    await this.journal.append(parent.id, {
      category: 'trace',
      type: EVENT_TYPES.childStarted,
      data: {
        childSessionId: child.id,
        forkEventId: forkEvent.id,
        configId: config.id,
        purpose: child.purpose,
      },
    });
    return child;
  }

  async completeChild(parentSessionId: string, result: ChildResult): Promise<void> {
    const child = await this.requireSession(result.childSessionId);
    if (child.parentSessionId !== parentSessionId) {
      throw new Error(`${child.id} is not a child of ${parentSessionId}`);
    }

    await this.journal.append(parentSessionId, {
      category: 'context',
      type: EVENT_TYPES.childCompleted,
      affectsContext: true,
      data: {
        result,
        message: {
          id: createId('msg'),
          role: 'user',
          createdAt: nowIso(),
          content: [
            {
              type: 'text',
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
            confidence: result.confidence,
            noneFound: result.noneFound ?? false,
            evidenceRefs: result.evidenceRefs,
            artifactRefs: result.artifactRefs,
          },
        },
      },
    });
  }

  async project(sessionId: string): Promise<ContextProjection> {
    return this.projectRecursive(sessionId, new Set());
  }

  private async projectRecursive(
    sessionId: string,
    visited: Set<string>,
  ): Promise<ContextProjection> {
    if (visited.has(sessionId)) throw new Error(`session ancestry cycle at ${sessionId}`);
    visited.add(sessionId);
    const session = await this.requireSession(sessionId);
    const events = await this.journal.read(session.id);

    if (session.parentSessionId === undefined || session.forkEventId === undefined) {
      return projectContext(session.id, events);
    }

    const parent = await this.requireSession(session.parentSessionId);
    const parentEvents = await this.journal.read(parent.id);
    const fork = parentEvents.find((event) => event.id === session.forkEventId);
    if (fork === undefined) throw new Error(`missing fork event ${session.forkEventId}`);
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
    if (session.parentSessionId === undefined || session.forkEventId === undefined) {
      return projectContext(session.id, events);
    }
    if (visited.has(session.parentSessionId)) {
      throw new Error(`session ancestry cycle at ${session.parentSessionId}`);
    }
    visited.add(session.parentSessionId);
    const parent = await this.requireSession(session.parentSessionId);
    const parentEvents = await this.journal.read(parent.id);
    const fork = parentEvents.find((event) => event.id === session.forkEventId);
    if (fork === undefined) throw new Error(`missing fork event ${session.forkEventId}`);
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
