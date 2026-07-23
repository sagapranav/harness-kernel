import { MemoryArtifactStore, type ArtifactStore } from "./artifacts.js";
import { MemoryJournalStore, type JournalStore } from "./journal.js";
import { MemoryProjectionStore, type ProjectionStore } from "./projection.js";
import { defaultRuntime, type RuntimeServices } from "./runtime.js";
import { MemorySessionCatalog, type SessionCatalog } from "./sessions.js";

export type StorageDurability = "ephemeral" | "durable";
export type StorageCoordination =
  "single_instance" | "single_process" | "multi_process" | "distributed";

export interface StorageComponentProfile {
  adapter: string;
  durability: StorageDurability;
  coordination: StorageCoordination;
  notes?: string;
}

/**
 * Per-port operational declarations. Mixed backends should describe each
 * component independently instead of claiming one capability for the bundle.
 */
export interface StorageProfile {
  name: string;
  journal: StorageComponentProfile;
  artifacts: StorageComponentProfile;
  projections: StorageComponentProfile;
  sessions: StorageComponentProfile;
}

/** All persistence ports consumed by a complete harness runtime. */
export interface HarnessStorage {
  journal: JournalStore;
  artifacts: ArtifactStore;
  projections: ProjectionStore;
  sessions: SessionCatalog;
  profile: StorageProfile;
}

export function createMemoryStorage(
  runtime: RuntimeServices = defaultRuntime,
): HarnessStorage {
  const ephemeral = (adapter: string): StorageComponentProfile => ({
    adapter,
    durability: "ephemeral",
    coordination: "single_instance",
  });
  return {
    journal: new MemoryJournalStore(runtime),
    artifacts: new MemoryArtifactStore(runtime),
    projections: new MemoryProjectionStore(),
    sessions: new MemorySessionCatalog(),
    profile: {
      name: "memory",
      journal: ephemeral("MemoryJournalStore"),
      artifacts: ephemeral("MemoryArtifactStore"),
      projections: ephemeral("MemoryProjectionStore"),
      sessions: ephemeral("MemorySessionCatalog"),
    },
  };
}
