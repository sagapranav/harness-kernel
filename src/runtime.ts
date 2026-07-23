/**
 * Host services used by the kernel when it must create identity, observe time,
 * or hash content. Inject this port for deterministic tests, isolated workers,
 * or runtimes with non-standard crypto APIs.
 */
export interface RuntimeServices {
  createId(prefix?: string): string;
  nowIso(): string;
  sha256(value: Uint8Array): Promise<string>;
}

interface PortableCrypto {
  randomUUID(): string;
  subtle: {
    digest(algorithm: "SHA-256", value: Uint8Array): Promise<ArrayBuffer>;
  };
}

function portableCrypto(): PortableCrypto {
  const crypto = (globalThis as { crypto?: PortableCrypto }).crypto;
  if (
    crypto === undefined ||
    typeof crypto.randomUUID !== "function" ||
    typeof crypto.subtle?.digest !== "function"
  ) {
    throw new Error(
      "this runtime does not expose Web Crypto; inject RuntimeServices",
    );
  }
  return crypto;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const defaultRuntime: RuntimeServices = Object.freeze({
  createId(prefix?: string): string {
    const id = portableCrypto().randomUUID();
    return prefix === undefined ? id : `${prefix}_${id}`;
  },
  nowIso(): string {
    return new Date().toISOString();
  },
  async sha256(value: Uint8Array): Promise<string> {
    const stable = new Uint8Array(value);
    return hex(await portableCrypto().subtle.digest("SHA-256", stable));
  },
});

export function createId(prefix?: string): string {
  return defaultRuntime.createId(prefix);
}

export function nowIso(): string {
  return defaultRuntime.nowIso();
}

export function sha256(value: Uint8Array): Promise<string> {
  return defaultRuntime.sha256(value);
}
