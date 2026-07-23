import { mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertExpectedJournalHead,
  assertSessionId,
  createJournalEvent,
  selectJournalEvents,
  validateChain,
  type AppendOptions,
  type JournalReadOptions,
  type JournalStore,
} from "../journal.js";
import { cloneJson } from "../json.js";
import type { AppendEventInput, JournalEvent } from "../protocol.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import { storageKey } from "./storage-key.js";

interface JournalFileState {
  events: JournalEvent[];
  /** Byte length of the fully written prefix; anything past it is a torn tail. */
  validBytes: number;
}

interface JournalTail {
  bytes: number;
  head: JournalEvent | null;
}

/**
 * One JSONL file per session. Writes are serialized per store instance and
 * synced before append resolves. A partial final line left by a crash
 * mid-write is ignored by reads and truncated before the next append;
 * corruption anywhere before the final line still fails loudly. Use one
 * instance per directory; distributed or multi-process writers require a
 * transactional JournalStore implementation.
 */
export class JsonlJournalStore implements JournalStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tails = new Map<string, JournalTail>();

  constructor(
    readonly rootDirectory: string,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {}

  async append<TData>(
    sessionId: string,
    input: AppendEventInput<TData>,
    options?: AppendOptions,
  ): Promise<JournalEvent<TData>> {
    const stableInput = cloneJson(input);
    let result: JournalEvent<TData> | undefined;
    await this.exclusive(sessionId, async () => {
      assertSessionId(sessionId);
      const path = this.eventPath(sessionId);
      const size = await this.fileSize(path);
      let tail = this.tails.get(sessionId);
      if (tail === undefined || tail.bytes !== size) {
        const loaded = await this.load(sessionId);
        if (loaded.validBytes < size) {
          await truncate(path, loaded.validBytes);
        }
        tail = { bytes: loaded.validBytes, head: loaded.events.at(-1) ?? null };
      }
      assertExpectedJournalHead(tail.head, options);
      const event = createJournalEvent(
        sessionId,
        tail.head,
        stableInput,
        this.runtime,
      );
      const line = `${JSON.stringify(event)}\n`;
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "a");
      try {
        await handle.writeFile(line);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      this.tails.set(sessionId, {
        bytes: tail.bytes + Buffer.byteLength(line, "utf8"),
        head: event as JournalEvent,
      });
      result = event;
    });
    return result!;
  }

  async read(
    sessionId: string,
    options?: JournalReadOptions,
  ): Promise<JournalEvent[]> {
    const { events } = await this.load(sessionId);
    return selectJournalEvents(events, options);
  }

  async head(sessionId: string): Promise<JournalEvent | null> {
    return (await this.load(sessionId)).events.at(-1) ?? null;
  }

  private async load(sessionId: string): Promise<JournalFileState> {
    assertSessionId(sessionId);
    const path = this.eventPath(sessionId);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], validBytes: 0 };
      }
      throw error;
    }

    const events: JournalEvent[] = [];
    let validBytes = 0;
    const lines = contents.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) {
        if (index < lines.length - 1) validBytes += 1;
        continue;
      }
      try {
        events.push(JSON.parse(line) as JournalEvent);
      } catch (error) {
        const isTail = lines
          .slice(index + 1)
          .every((rest) => rest.length === 0);
        if (isTail) break;
        throw new Error(`invalid journal JSON at ${path}:${index + 1}`, {
          cause: error,
        });
      }
      validBytes += Buffer.byteLength(line, "utf8") + 1;
    }
    validateChain(sessionId, events);
    return { events, validBytes };
  }

  private async fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
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
