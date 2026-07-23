import { join } from "node:path";
import type { HarnessStorage } from "../storage.js";
import { defaultRuntime, type RuntimeServices } from "../runtime.js";
import { FileArtifactStore } from "./artifacts.js";
import { JsonlJournalStore } from "./journal.js";
import { FileProjectionStore } from "./projection.js";
import { FileSessionCatalog } from "./sessions.js";

/** Creates a durable, single-process reference storage bundle. */
export function createFileStorage(
  rootDirectory: string,
  runtime: RuntimeServices = defaultRuntime,
): HarnessStorage {
  return {
    journal: new JsonlJournalStore(join(rootDirectory, "journals"), runtime),
    artifacts: new FileArtifactStore(join(rootDirectory, "artifacts"), runtime),
    projections: new FileProjectionStore(
      join(rootDirectory, "projections"),
      runtime,
    ),
    sessions: new FileSessionCatalog(join(rootDirectory, "catalog"), runtime),
    profile: {
      name: "node-filesystem",
      journal: {
        adapter: "JsonlJournalStore",
        durability: "durable",
        coordination: "single_instance",
        notes: "Use one instance per root; replace for multi-process writers.",
      },
      artifacts: {
        adapter: "FileArtifactStore",
        durability: "durable",
        coordination: "multi_process",
      },
      projections: {
        adapter: "FileProjectionStore",
        durability: "durable",
        coordination: "multi_process",
        notes: "Last atomic replacement wins; projections are disposable.",
      },
      sessions: {
        adapter: "FileSessionCatalog",
        durability: "durable",
        coordination: "multi_process",
      },
    },
  };
}
