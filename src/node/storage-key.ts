import { createHash } from "node:crypto";

/**
 * Maps an opaque application identifier to one bounded filesystem component.
 */
export function storageKey(value: string, label = "identifier"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}
