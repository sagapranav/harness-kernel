import { mkdir, open, readFile } from "node:fs/promises";
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

/**
 * One JSONL file per session. Writes are serialized per store instance and
 * synced before append resolves. Use one instance per directory; distributed
 * or multi-process writers require a transactional JournalStore implementation.
 */
export class JsonlJournalStore implements JournalStore {
  private readonly queues = new Map<string, Promise<void>>();

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
      const events = await this.read(sessionId);
      const head = events.at(-1) ?? null;
      assertExpectedJournalHead(head, options);
      const event = createJournalEvent(
        sessionId,
        head,
        stableInput,
        this.runtime,
      );
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
            { cause: error },
          );
        }
      });
    validateChain(sessionId, events);
    return selectJournalEvents(events, options);
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
