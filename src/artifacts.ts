import type { ArtifactRef } from "./protocol.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";

export interface PutArtifactOptions {
  mediaType?: string;
  name?: string;
}

export interface ArtifactStore {
  /**
   * Persist bytes under their SHA-256 digest. Repeated puts of the same bytes
   * must be idempotent and must not alter existing content.
   */
  put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  /** Test content-address existence without returning mutable store state. */
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

export function artifactBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
}

export async function artifactReference(
  value: Uint8Array,
  options?: PutArtifactOptions,
  runtime: RuntimeServices = defaultRuntime,
): Promise<ArtifactRef> {
  const sha256 = await runtime.sha256(value);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError(
      "runtime sha256 must return 64 lowercase hexadecimal characters",
    );
  }
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

  constructor(readonly runtime: RuntimeServices = defaultRuntime) {}

  async put(
    value: Uint8Array | string,
    options?: PutArtifactOptions,
  ): Promise<ArtifactRef> {
    const data = artifactBytes(value);
    const ref = await artifactReference(data, options, this.runtime);
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
