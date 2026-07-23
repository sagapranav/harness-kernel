import { EVENT_TYPES, foldProjection } from "../projection.js";
import type { ArtifactStore } from "../artifacts.js";
import type { HarnessStorage } from "../storage.js";
import { telemetryProjection, type TelemetrySummary } from "../telemetry.js";
import type {
  ArtifactRef,
  ImmutableRunConfig,
  JournalEvent,
  SessionDescriptor,
} from "../protocol.js";
import { VIEWER_CLIENT_JS, VIEWER_STYLES } from "./viewer-assets.js";

export interface SessionViewerOptions {
  /** Inline image artifacts as data URLs so they render. Default true. */
  inlineImages?: boolean;
  /** Skip inlining any single image larger than this many bytes. Default 4 MB. */
  maxImageBytes?: number;
  /** Recurse into child (sub-agent) sessions. Default true. */
  includeChildren?: boolean;
  /** Page title. Default "Harness session <id>". */
  title?: string;
}

export interface ViewerSession {
  id: string;
  descriptor: SessionDescriptor | null;
  config: ImmutableRunConfig | null;
  events: JournalEvent[];
  telemetry: TelemetrySummary;
  childIds: string[];
}

export interface ViewerBundle {
  rootSessionId: string;
  generatedNote: string;
  sessions: Record<string, ViewerSession>;
  /** sha256 -> data URL for inlined images. */
  images: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function childSessionIds(events: JournalEvent[]): string[] {
  const ids: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id === "string" && id.length > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  };
  for (const event of events) {
    // child.started is present for out-of-loop dispatch; a spawn-as-a-tool
    // fork skips it (linkInParent: false), but child.completed still names
    // the child, so discover from both.
    if (event.type === EVENT_TYPES.childStarted) {
      add(record(event.data).childSessionId);
    } else if (event.type === EVENT_TYPES.childCompleted) {
      add(record(record(event.data).result).childSessionId);
    }
  }
  return ids;
}

function imageRefs(events: JournalEvent[]): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const candidate of blocks) {
      const block = record(candidate);
      if (block.type === "image") {
        const ref = record(block.artifact);
        if (typeof ref.sha256 === "string" && typeof ref.bytes === "number") {
          refs.push(ref as unknown as ArtifactRef);
        }
      } else if (block.type === "tool_result") {
        walk(block.content);
      }
    }
  };
  for (const event of events) {
    if (event.type !== EVENT_TYPES.messageAppended) continue;
    walk(record(record(event.data).message).content);
  }
  return refs;
}

/**
 * Reads a session, its immutable config, its telemetry, and (recursively) its
 * sub-agent sessions into a single serializable bundle for the viewer. Image
 * artifacts are inlined as data URLs when small enough to render.
 */
export async function collectSessionBundle(
  storage: HarnessStorage,
  rootSessionId: string,
  options: SessionViewerOptions = {},
): Promise<ViewerBundle> {
  const includeChildren = options.includeChildren !== false;
  const wantImages = options.inlineImages !== false;
  const maxImageBytes = options.maxImageBytes ?? 4 * 1024 * 1024;
  const sessions: Record<string, ViewerSession> = {};
  const images: Record<string, string> = {};
  const pending = [rootSessionId];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const events = await storage.journal.read(id);
    const descriptor = await storage.sessions.getSession(id);
    const config =
      descriptor === null
        ? null
        : await storage.sessions.getConfig(descriptor.configId);
    const telemetry = foldProjection(id, events, telemetryProjection).state;
    const childIds = childSessionIds(events);
    sessions[id] = { id, descriptor, config, events, telemetry, childIds };

    if (includeChildren) {
      for (const childId of childIds) pending.push(childId);
    }
    if (wantImages) {
      await inlineImages(storage.artifacts, events, maxImageBytes, images);
    }
  }

  return {
    rootSessionId,
    generatedNote:
      "Rendered from the raw journal. The raw events are authoritative; this view is a disposable projection.",
    sessions,
    images,
  };
}

async function inlineImages(
  artifacts: ArtifactStore,
  events: JournalEvent[],
  maxImageBytes: number,
  into: Record<string, string>,
): Promise<void> {
  for (const ref of imageRefs(events)) {
    if (into[ref.sha256] !== undefined) continue;
    if (ref.bytes > maxImageBytes) continue;
    try {
      const bytes = await artifacts.get(ref);
      into[ref.sha256] =
        "data:" +
        (ref.mediaType || "application/octet-stream") +
        ";base64," +
        Buffer.from(bytes).toString("base64");
    } catch {
      // Missing or corrupt artifact: the viewer shows a reference placeholder.
    }
  }
}

// JSON is embedded in a <script> tag; only "<" must be neutralized so a value
// containing "</script>" cannot end the block. U+2028/U+2029 are valid inside
// JSON strings and are parsed correctly by JSON.parse.
function escapeJsonForScript(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Renders a self-contained HTML transcript viewer for a session and its
 * sub-agents. The returned string has no external dependencies; write it to a
 * file and open it locally. Three tabs: Overview (pinned config, system
 * prompt, initial prompt, telemetry), Transcript (readable conversation with
 * telemetry and inline images), and Raw (clean per-event JSONL). A session
 * switcher navigates into sub-agent transcripts.
 */
export async function renderSessionViewer(
  storage: HarnessStorage,
  rootSessionId: string,
  options: SessionViewerOptions = {},
): Promise<string> {
  const bundle = await collectSessionBundle(storage, rootSessionId, options);
  const title = options.title ?? "Harness session " + rootSessionId;
  const data = escapeJsonForScript(JSON.stringify(bundle));
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    "<title>" +
    escapeHtml(title) +
    "</title>\n<style>" +
    VIEWER_STYLES +
    "</style>\n</head>\n<body>\n" +
    '<div id="app"></div>\n' +
    '<script type="application/json" id="viewer-data">' +
    data +
    "</script>\n<script>" +
    VIEWER_CLIENT_JS +
    "</script>\n</body>\n</html>\n"
  );
}
