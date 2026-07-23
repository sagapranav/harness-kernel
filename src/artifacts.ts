import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef } from './protocol.js';

export interface PutArtifactOptions {
  mediaType?: string;
  name?: string;
}

export interface ArtifactStore {
  put(value: Uint8Array | string, options?: PutArtifactOptions): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function reference(value: Uint8Array, options?: PutArtifactOptions): ArtifactRef {
  const sha256 = createHash('sha256').update(value).digest('hex');
  return {
    sha256,
    uri: `sha256:${sha256}`,
    bytes: value.byteLength,
    mediaType: options?.mediaType ?? 'application/octet-stream',
    ...(options?.name === undefined ? {} : { name: options.name }),
  };
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(value: Uint8Array | string, options?: PutArtifactOptions): Promise<ArtifactRef> {
    const data = bytes(value);
    const ref = reference(data, options);
    this.values.set(ref.sha256, new Uint8Array(data));
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    const value = this.values.get(ref.sha256);
    if (value === undefined) throw new Error(`artifact not found: ${ref.uri}`);
    return new Uint8Array(value);
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    return this.values.has(ref.sha256);
  }
}

/** Content-addressed filesystem storage with atomic, idempotent writes. */
export class FileArtifactStore implements ArtifactStore {
  constructor(readonly rootDirectory: string) {}

  async put(value: Uint8Array | string, options?: PutArtifactOptions): Promise<ArtifactRef> {
    const data = bytes(value);
    const ref = reference(data, options);
    const path = this.pathFor(ref);
    await mkdir(join(this.rootDirectory, ref.sha256.slice(0, 2)), { recursive: true });
    if (await this.has(ref)) return ref;

    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(await this.has(ref))) throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return ref;
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(ref)));
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    try {
      await stat(this.pathFor(ref));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private pathFor(ref: ArtifactRef): string {
    return join(this.rootDirectory, ref.sha256.slice(0, 2), ref.sha256);
  }
}
