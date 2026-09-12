import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cloneJson } from "../json.js";
import {
  MemoryMailboxStore,
  type MailboxDelivery,
  type MailboxMessage,
  type MailboxReadOptions,
  type MailboxRecord,
  type MailboxSnapshot,
  type MailboxStore,
} from "../mailbox.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import type { StorageComponentProfile } from "../storage.js";
import { storageKey } from "./storage-key.js";

/**
 * Durable single-instance reference mailbox. A complete versioned snapshot is
 * flushed, atomically renamed, then the directory is synced before writes return.
 * O(n) snapshot I/O; use a transactional database adapter for large/distributed inboxes.
 * Multiple writing instances/processes for one root are not supported.
 */
export class FileMailboxStore implements MailboxStore {
  readonly profile: StorageComponentProfile = {
    adapter: "FileMailboxStore",
    durability: "durable",
    coordination: "single_instance",
    notes:
      "One writing instance per root; atomic snapshots, O(n) I/O. Replace for distributed use.",
  };
  private tail: Promise<unknown> = Promise.resolve();
  readonly rootDirectory: string;

  constructor(
    rootDirectory: string,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {
    this.rootDirectory = resolve(rootDirectory);
  }

  send(message: MailboxMessage): Promise<MailboxRecord> {
    const stable = cloneJson(message);
    return this.exclusive(async () => {
      const store = await this.load();
      const record = await store.send(stable);
      await this.save(store.snapshot());
      return record;
    });
  }

  get(messageId: string): Promise<MailboxRecord | null> {
    return this.exclusive(async () => (await this.load()).get(messageId));
  }

  read(
    recipientSessionId: string,
    options: MailboxReadOptions = {},
  ): Promise<MailboxRecord[]> {
    const stable = cloneJson(options);
    return this.exclusive(async () =>
      (await this.load()).read(recipientSessionId, stable),
    );
  }

  acknowledge(
    messageId: string,
    delivery: MailboxDelivery,
  ): Promise<MailboxRecord> {
    const stable = cloneJson(delivery);
    return this.exclusive(async () => {
      const store = await this.load();
      const record = await store.acknowledge(messageId, stable);
      await this.save(store.snapshot());
      return record;
    });
  }

  pendingRecipients(): Promise<string[]> {
    return this.exclusive(async () => (await this.load()).pendingRecipients());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<MemoryMailboxStore> {
    let contents: string;
    try {
      contents = await readFile(
        join(this.rootDirectory, "mailbox.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new MemoryMailboxStore(this.runtime);
      }
      throw error;
    }
    // Corrupt or future snapshots fail; never silently replace them with an empty inbox.
    return new MemoryMailboxStore(
      this.runtime,
      JSON.parse(contents) as MailboxSnapshot,
    );
  }

  private async save(snapshot: MailboxSnapshot): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const temporary = join(
      this.rootDirectory,
      `${storageKey(this.runtime.createId("mailbox"))}.tmp`,
    );
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, join(this.rootDirectory, "mailbox.json"));
      await syncDirectory(this.rootDirectory);
      await syncDirectory(dirname(this.rootDirectory));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
