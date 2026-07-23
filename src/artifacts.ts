import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef } from "./protocol.js";

export interface PutArtifactOptions {
  mediaType?: string;
  name?: string;
}

export interface ArtifactStore {
  put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

export class ArtifactIntegrityError extends Error {
  constructor(readonly ref: ArtifactRef) {
    super(`artifact failed integrity verification: ${ref.uri}`);
    this.name = "ArtifactIntegrityError";
  }
}

export function assertArtifactRef(ref: ArtifactRef): void {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new TypeError(
      "artifact sha256 must be 64 lowercase hexadecimal characters",
    );
  }
  if (ref.uri !== `sha256:${ref.sha256}`) {
    throw new TypeError("artifact uri does not match its sha256 digest");
  }
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new TypeError(
      "artifact byte count must be a non-negative safe integer",
    );
  }
  if (typeof ref.mediaType !== "string" || ref.mediaType.length === 0) {
    throw new TypeError("artifact media type must not be empty");
  }
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
}

function reference(
  value: Uint8Array,
  options?: PutArtifactOptions,
): ArtifactRef {
  const sha256 = createHash("sha256").update(value).digest("hex");
  return {
    sha256,
    uri: `sha256:${sha256}`,
    bytes: value.byteLength,
    mediaType: options?.mediaType ?? "application/octet-stream",
    ...(options?.name === undefined ? {} : { name: options.name }),
  };
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef> {
    const data = bytes(value);
    const ref = reference(data, options);
    this.values.set(ref.sha256, new Uint8Array(data));
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    assertArtifactRef(ref);
    const value = this.values.get(ref.sha256);
    if (value === undefined) throw new Error(`artifact not found: ${ref.uri}`);
    if (value.byteLength !== ref.bytes) throw new ArtifactIntegrityError(ref);
    return new Uint8Array(value);
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    return this.values.has(ref.sha256);
  }
}

/** Content-addressed filesystem storage with atomic, idempotent writes. */
export class FileArtifactStore implements ArtifactStore {
  constructor(readonly rootDirectory: string) {}

  async put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef> {
    const data = bytes(value);
    const ref = reference(data, options);
    const path = this.pathFor(ref);
    await mkdir(join(this.rootDirectory, ref.sha256.slice(0, 2)), {
      recursive: true,
    });
    if (await this.has(ref)) {
      await this.get(ref);
      return ref;
    }

    const temporary = `${path}.${randomUUID()}.tmp`;
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
    const actual = reference(value, {
      mediaType: ref.mediaType,
      name: ref.name,
    });
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
}
