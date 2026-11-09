import type { Edge, Node } from "@xyflow/react";
import type { ModelRouteTier } from "../modelOperations/types";

export type RouteCanvasNodeKind =
  | "model"
  | "mapping"
  | "resolution"
  | "upscale"
  | "quality"
  | "strategy"
  | "publish";

export type RouteResolution = "480p" | "720p" | "1080p" | "2K" | "4K";

export interface StrategyEntry {
  sourceNodeId: string;
  label: string;
  channelName: string;
  tier: ModelRouteTier;
  weight: number;
}

export interface RouteCanvasNodeData extends Record<string, unknown> {
  kind: RouteCanvasNodeKind;
  title: string;
  subtitle?: string;
  status?: "ready" | "draft" | "warning";
  poolId?: string;
  routeTargetId?: string;
  scope?: "platform" | "workspace";
  workspaceId?: string | null;
  endpointType?: string;
  channelId?: string;
  channelName?: string;
  provider?: string;
  upstreamModel?: string;
  health?: "healthy" | "degraded" | "unhealthy" | "unknown";
  nativeResolution?: RouteResolution;
  resolutionAware?: boolean;
  sourceResolution?: RouteResolution;
  targetResolution?: RouteResolution;
  upscaleFactor?: "1.5" | "2" | "4";
  enhanceChannelId?: string;
  enhanceChannelName?: string;
  publicModel?: string;
  displayName?: string;
  pricingUnit?: string;
  priceGu?: string;
  reservationTokens?: number;
  pricingRuleConfig?: Record<string, unknown>;
  enabled?: boolean;
  existingGroupKey?: string | null;
  strategyEntries?: StrategyEntry[];
}

export type RouteCanvasNode = Node<RouteCanvasNodeData, RouteCanvasNodeKind>;
export type RouteCanvasEdge = Edge;

export interface RouteCanvasSnapshot {
  id: string;
  savedAt: number;
  label: string;
  nodes: RouteCanvasNode[];
  edges: RouteCanvasEdge[];
}

export interface RouteCanvasDocument {
  schemaVersion: 1;
  nodes: RouteCanvasNode[];
  edges: RouteCanvasEdge[];
  snapshots: RouteCanvasSnapshot[];
}
