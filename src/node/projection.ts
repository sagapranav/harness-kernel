import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloneJson } from "../json.js";
import {
  assertProjectionSnapshot,
  type ProjectionSnapshot,
  type ProjectionStore,
} from "../projection.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import { storageKey } from "./storage-key.js";

/** Replaceable filesystem materialized views. Raw journals stay authoritative. */
export class FileProjectionStore implements ProjectionStore {
  constructor(
    readonly rootDirectory: string,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {}

  async load<TState>(
    sessionId: string,
    name: string,
    version: number,
  ): Promise<ProjectionSnapshot<TState> | null> {
    try {
      const snapshot = JSON.parse(
        await readFile(this.path(sessionId, name, version), "utf8"),
      ) as ProjectionSnapshot<TState>;
      assertProjectionSnapshot(snapshot, { sessionId, name, version });
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save<TState>(snapshot: ProjectionSnapshot<TState>): Promise<void> {
    assertProjectionSnapshot(snapshot);
    const stableSnapshot = cloneJson(snapshot);
    const path = this.path(
      stableSnapshot.sessionId,
      stableSnapshot.name,
      stableSnapshot.version,
    );
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${storageKey(
      this.runtime.createId("projection"),
      "temporary id",
    )}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stableSnapshot, null, 2)}\n`, {
      flag: "wx",
    });
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private path(sessionId: string, name: string, version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError("projection version must be a positive safe integer");
    }
    return join(
      this.rootDirectory,
      storageKey(sessionId, "session id"),
      `${storageKey(name, "projection name")}-v${version}.json`,
    );
  }
}
