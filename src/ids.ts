import { randomUUID } from "node:crypto";

/** Generates an opaque identifier. Consumers may replace it at every boundary. */
export function createId(prefix?: string): string {
  const id = randomUUID();
  return prefix === undefined ? id : `${prefix}_${id}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
