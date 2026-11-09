import type { Knex } from "knex";
import { assertMembershipFeature } from "./membership";
import { type MembershipFeature } from "./membershipCatalog";

const routeFeatures: Record<string, MembershipFeature> = {
  "/workbench/create/directorPlan": "storyboard",
  "/production/storyboard/batchGenerateImage": "storyboard",
  "/script/getAiRegex": "storyboard",
  "/script/extractAssets": "storyboard",
  "/production/director/saveScene": "director",
  "/workbench/canvas/composeVideo": "analysis",
  "/workbench/canvas/videoStoryAnalysis": "analysis",
  "/production/workbench/renderFinalVideo": "analysis",
  "/canvas/workflows": "workflow",
  "/production/workflowGraph/save": "workflow",
};

const normalizedRouteFeatures = Object.fromEntries(Object.entries(routeFeatures).map(([path, feature]) => [path.toLowerCase(), feature]));

/** Content mutations that do not necessarily invoke a paid tool or a PUT.
 * Reads, deletion, cancellation and completion of accepted work stay available. */
export function membershipSharedWriteForRequest(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH"].includes(method.toUpperCase())) return false;
  const route = path.split("?")[0].toLowerCase().replace(/^\/api(?=\/)/, "");
  if (!/^\/(?:projects|project-folders|assets|assetsgenerate|cornerscape|script|scriptagent|novel|production|canvas|workbench)(?:\/|$)/.test(route)) return false;
  if (/\/(?:get|list|read|poll|check|preview|export|query|downpreview|delete|remove|cancel|abort|complete|finish|status|download|quote|estimate|refresh)[^/]*(?:\/|$)/.test(route)) return false;
  // Generation/storage services enforce their own atomic admission and allow
  // replay/recovery. Do not reject an already-paid result at the HTTP layer.
  if (/\/(?:generate|batchgenerate|upload|create\/images|create\/videos|create\/generations)[^/]*(?:\/|$)/.test(route)) return false;
  return true;
}

export function membershipFeatureForRequest(method: string, path: string, body: Record<string, any> = {}): MembershipFeature | null {
  if (method.toUpperCase() !== "POST") return null;
  body = body && typeof body === "object" ? body : {};
  const route = path.split("?")[0].toLowerCase().replace(/^\/api(?=\/)/, "").replace(/\/$/, "");
  if (/^\/agent\/threads\/[^/]+\/messages$/.test(route)) return "storyboard";
  if (/^\/assets\/library\/[^/]+\/(grants|transfer-to-workspace)$/.test(route)) return "shared";
  // Member and API-key changes validate live authority first, then compare
  // entitlement needs with the locked row in their mutation routes.
  if (route === "/workbench/canvas/generate" && body.operation === "edit") return "rewrite";
  if (route.startsWith("/workbench/canvas/videostoryanalysis/") && !route.endsWith("/status") && !route.endsWith("/cancel")) return "analysis";
  return normalizedRouteFeatures[route] ?? null;
}

export function membershipFeatureForTool(toolName: string, args: unknown): MembershipFeature | null {
  if (["script.draft.create", "script.draft.update", "storyboard.draft.upsert", "storyboard.draft.reorder"].includes(toolName)) return "storyboard";
  if (["video.merge", "delivery.draft.create", "delivery.publish"].includes(toolName)) return "analysis";
  if (toolName === "delivery.share") return "shared";
  if (toolName === "generation.video.submit" && args && typeof args === "object" && (args as any).operation === "edit") return "rewrite";
  return null;
}

export async function assertMembershipTool(workspaceId: string, toolName: string, args: unknown, client: Knex | Knex.Transaction) {
  const feature = membershipFeatureForTool(toolName, args);
  if (feature) await assertMembershipFeature(workspaceId, feature, client);
}
