import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactIntegrityError,
  artifactBytes,
  artifactReference,
  assertArtifactRef,
  type ArtifactStore,
  type PutArtifactOptions,
} from "../artifacts.js";
import type { ArtifactRef } from "../protocol.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import { storageKey } from "./storage-key.js";

/** Content-addressed filesystem storage with atomic, idempotent writes. */
export class FileArtifactStore implements ArtifactStore {
  constructor(
    readonly rootDirectory: string,
    readonly runtime: RuntimeServices = defaultRuntime,
  ) {}

  async put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef> {
    const data = artifactBytes(value);
    const ref = await artifactReference(data, options, this.runtime);
    const path = this.pathFor(ref);
    await mkdir(join(this.rootDirectory, ref.sha256.slice(0, 2)), {
      recursive: true,
    });
    if (await this.has(ref)) {
      await this.get(ref);
      return ref;
    }

    const temporary = `${path}.${this.temporaryKey("artifact")}.tmp`;
    await writeFile(temporary, data, { flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(await this.has(ref))) throw error;
      await this.get(ref);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    const value = new Uint8Array(await readFile(this.pathFor(ref)));
    const actual = await artifactReference(
      value,
      { mediaType: ref.mediaType, name: ref.name },
      this.runtime,
    );
    if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.bytes) {
      throw new ArtifactIntegrityError(ref);
    }
    return value;
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    try {
      await stat(this.pathFor(ref));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private pathFor(ref: ArtifactRef): string {
    assertArtifactRef(ref);
    return join(this.rootDirectory, ref.sha256.slice(0, 2), ref.sha256);
  }

  private temporaryKey(prefix: string): string {
    return storageKey(this.runtime.createId(prefix), "temporary id");
  }
}
