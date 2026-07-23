import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloneJson, jsonEqual } from "../json.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import {
  assertRunConfig,
  assertSessionDescriptor,
  type SessionCatalog,
} from "../sessions.js";
import type { ImmutableRunConfig, SessionDescriptor } from "../protocol.js";
import { storageKey } from "./storage-key.js";

/** Immutable JSON descriptors/configs. Journals remain in the JournalStore. */
export class FileSessionCatalog implements SessionCatalog {
  constructor(
    readonly rootDirectory: string,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {}

  async putSession(session: SessionDescriptor): Promise<void> {
    assertSessionDescriptor(session);
    const stableSession = cloneJson(session);
    await this.writeOnce(this.sessionPath(stableSession.id), stableSession);
  }

  async getSession(sessionId: string): Promise<SessionDescriptor | null> {
    const session = await this.readJson<SessionDescriptor>(
      this.sessionPath(sessionId),
    );
    if (session !== null) assertSessionDescriptor(session);
    return session;
  }

  async putConfig(config: ImmutableRunConfig): Promise<void> {
    assertRunConfig(config);
    const stableConfig = cloneJson(config);
    const existing = await this.getConfig(stableConfig.id);
    if (existing !== null) {
      if (!jsonEqual(existing, stableConfig)) {
        throw new Error(`immutable config conflict: ${stableConfig.id}`);
      }
      return;
    }
    await this.writeOnce(this.configPath(stableConfig.id), stableConfig);
  }

  async getConfig(configId: string): Promise<ImmutableRunConfig | null> {
    const config = await this.readJson<ImmutableRunConfig>(
      this.configPath(configId),
    );
    if (config !== null) assertRunConfig(config);
    return config;
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeOnce(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${storageKey(
      this.runtime.createId("catalog"),
      "temporary id",
    )}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    try {
      await link(temporary, path);
    } catch (error) {
      const existing = await this.readJson<unknown>(path);
      if (existing === null) throw error;
      if (!jsonEqual(existing, value))
        throw new Error(`immutable value conflict: ${path}`);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private sessionPath(sessionId: string): string {
    return join(
      this.rootDirectory,
      "sessions",
      storageKey(sessionId, "session id"),
      "session.json",
    );
  }

  private configPath(configId: string): string {
    return join(
      this.rootDirectory,
      "configs",
      `${storageKey(configId, "config id")}.json`,
    );
  }
}
