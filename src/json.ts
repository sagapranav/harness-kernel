/**
 * Rejects values whose JSON representation is lossy, ambiguous, or cyclic.
 * Durable protocol data should round-trip without relying on custom `toJSON`.
 */
export function assertJsonSerializable(value: unknown, path = "$"): void {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, currentPath: string): void => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError(`${currentPath} contains a non-finite number`);
      }
      if (Object.is(candidate, -0)) {
        throw new TypeError(`${currentPath} contains negative zero`);
      }
      return;
    }
    if (
      candidate === undefined ||
      typeof candidate === "bigint" ||
      typeof candidate === "function" ||
      typeof candidate === "symbol"
    ) {
      throw new TypeError(`${currentPath} is not JSON-serializable`);
    }
    if (typeof candidate !== "object") {
      throw new TypeError(`${currentPath} is not JSON-serializable`);
    }
    if (seen.has(candidate))
      throw new TypeError(`${currentPath} contains a cycle`);
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new TypeError(`${currentPath} must be a plain array`);
        }
        const keys = Reflect.ownKeys(candidate).filter(
          (key) => key !== "length",
        );
        if (
          keys.length !== candidate.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          throw new TypeError(
            `${currentPath} must not contain holes, symbol keys, or extra properties`,
          );
        }
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            candidate,
            String(index),
          );
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
          ) {
            throw new TypeError(
              `${currentPath}[${index}] must be an enumerable data property`,
            );
          }
          visit(descriptor.value, `${currentPath}[${index}]`);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(candidate) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${currentPath} must be a plain object`);
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw new TypeError(`${currentPath} must not contain symbol keys`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          throw new TypeError(
            `${currentPath}.${key} must be an enumerable data property`,
          );
        }
        visit(descriptor.value, `${currentPath}.${key}`);
      }
    } finally {
      seen.delete(candidate);
    }
  };

  visit(value, path);
}

export function cloneJson<T>(value: T): T {
  assertJsonSerializable(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable JSON encoding for semantic equality and content hashing. */
export function canonicalJson(value: unknown): string {
  assertJsonSerializable(value);
  const sort = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sort);
    if (typeof candidate !== "object" || candidate === null) return candidate;
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sort(item)]),
    );
  };
  return JSON.stringify(sort(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
