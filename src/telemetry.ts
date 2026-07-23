import type { JournalEvent, ModelTelemetry } from "./protocol.js";
import type { ProjectionDefinition } from "./projection.js";
import { EVENT_TYPES } from "./projection.js";

export interface TelemetrySummary {
  modelCalls: number;
  actionCalls: number;
  actionFailures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
  stopReasons: Record<string, number>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function modelTelemetry(event: JournalEvent): ModelTelemetry | null {
  const telemetry = record(event.data).telemetry;
  return typeof telemetry === "object" && telemetry !== null
    ? (telemetry as ModelTelemetry)
    : null;
}

export const telemetryProjection: ProjectionDefinition<TelemetrySummary> = {
  name: "telemetry",
  version: 1,
  initial: () => ({
    modelCalls: 0,
    actionCalls: 0,
    actionFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    stopReasons: {},
  }),
  reduce: (state, event) => {
    if (event.type === EVENT_TYPES.modelCallCompleted) {
      const telemetry = modelTelemetry(event);
      if (telemetry === null) return state;
      return {
        ...state,
        modelCalls: state.modelCalls + 1,
        inputTokens: state.inputTokens + telemetry.usage.inputTokens,
        outputTokens: state.outputTokens + telemetry.usage.outputTokens,
        cacheReadTokens:
          state.cacheReadTokens + (telemetry.usage.cacheReadTokens ?? 0),
        cacheWriteTokens:
          state.cacheWriteTokens + (telemetry.usage.cacheWriteTokens ?? 0),
        reasoningTokens:
          state.reasoningTokens + (telemetry.usage.reasoningTokens ?? 0),
        costUsd: state.costUsd + (telemetry.costUsd ?? 0),
        latencyMs: state.latencyMs + telemetry.latencyMs,
        stopReasons: {
          ...state.stopReasons,
          [telemetry.stopReason]:
            (state.stopReasons[telemetry.stopReason] ?? 0) + 1,
        },
      };
    }
    if (event.type === EVENT_TYPES.actionCompleted) {
      const receipt = record(record(event.data).receipt);
      return {
        ...state,
        actionCalls: state.actionCalls + 1,
        actionFailures:
          state.actionFailures + (receipt.status === "failed" ? 1 : 0),
      };
    }
    return state;
  },
};
