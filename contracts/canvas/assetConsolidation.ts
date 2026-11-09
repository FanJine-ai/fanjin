type AssetNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  assetVersionId?: number | string;
};
type AssetEdge = { id: string; fromNodeId: string; toNodeId: string };
type AssetGroup = { id: string; nodeIds: string[]; groupType?: string };
type Graph<N, E, G> = { nodes: readonly N[]; edges: readonly E[]; groups: readonly G[] };

// Presentation and measured metadata do not change the referenced asset. Every
// other field participates in equality, including unknown future edit settings.
const presentationFields = new Set([
  "id", "title", "titleCustomized", "fileName", "x", "y", "width", "height",
  "mediaNaturalWidth", "mediaNaturalHeight", "mediaDurationMs", "videoPosterUrl",
  "localPreviewUrl", "localVideoUrl", "localAudioUrl", "uploadProgress",
  "generationProgress", "statusChipText", "statusChipTone",
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function referenceKey(node: AssetNode): string | null {
  const data = node as AssetNode & Record<string, unknown>;
  const version = Number(node.assetVersionId);
  if (!["image", "video", "audio"].includes(node.type)
    || !Number.isSafeInteger(version) || version <= 0) return null;
  if (data.isGenerating || data.taskId || data.videoStoryTaskId || data.videoStoryAnalyzing
    || data.scriptWorkflow || data.videoRewritePending || data.storyboardCellKey
    || data.storyboardSlotPlaceholder || data.storyboardSlotFilledByUser
    || ["submitting", "processing"].includes(String(data.generationState))
    || ["processing", "pending_reconcile", "failed"].includes(String(data.taskStatus))
    || ["preparing", "uploading", "failed"].includes(String(data.uploadState))
    || Object.entries(data).some(([key, value]) => key.endsWith("AttemptId") && value)
    || (Array.isArray(data.generationVersions) && data.generationVersions.length > 0)
    || (Array.isArray(data.generatedImages) && data.generatedImages.length > 0)) return null;
  // Require durable media; never merge an unfinished upload just by its id.
  if (![data.imageUrl, data.primaryImageUrl, data.videoUrl, data.audioUrl, data.referenceAssetUri]
    .some(value => typeof value === "string" && value.trim() && !/^(blob:|data:)/.test(value))) return null;
  const semanticFields = Object.fromEntries(Object.entries(data)
    .filter(([key]) => !presentationFields.has(key)));
  semanticFields.assetVersionId = version;
  return JSON.stringify(stableValue(semanticFields));
}

/** Merge only interchangeable leaf references. Edge order is input order for
 * @imageN/@videoN, so rewiring must never sort or deduplicate the edge array. */
export function consolidateCanvasAssets<N extends AssetNode, E extends AssetEdge, G extends AssetGroup>(
  graph: Graph<N, E, G>,
) {
  const protectedIds = new Set(graph.edges.map(edge => edge.toNodeId));
  const outgoing = new Map<string, Set<string>>();
  graph.edges.forEach(edge => {
    const targets = outgoing.get(edge.fromNodeId) ?? new Set<string>();
    targets.add(edge.toNodeId);
    outgoing.set(edge.fromNodeId, targets);
  });
  graph.groups.forEach(group => {
    if (group.groupType && group.groupType !== "default") group.nodeIds.forEach(id => protectedIds.add(id));
  });
  // Keep ids used outside ordinary edges stable (composition clips, provenance,
  // script-generated nodes, etc.). Future node-id fields are protected too.
  function protectReferences(value: unknown, key = "") {
    if (typeof value === "string" && /nodeids?$/i.test(key)) protectedIds.add(value);
    else if (Array.isArray(value)) value.forEach(item => protectReferences(item, key));
    else if (value && typeof value === "object") Object.entries(value)
      .forEach(([childKey, item]) => protectReferences(item, childKey));
  }
  graph.nodes.forEach(node => protectReferences(node));

  const buckets = new Map<string, Array<{ id: string; targets: Set<string> }>>();
  const replacements = new Map<string, string>();
  graph.nodes.forEach(node => {
    if (protectedIds.has(node.id)) return;
    const key = referenceKey(node);
    if (!key) return;
    const targets = outgoing.get(node.id) ?? new Set<string>();
    const candidates = buckets.get(key) ?? [];
    // Two copies used by the same target may occupy different reference slots.
    // Keep those copies distinct instead of changing the prompt's numbering.
    const canonical = candidates.find(candidate => [...targets].every(id => !candidate.targets.has(id)));
    if (canonical) {
      replacements.set(node.id, canonical.id);
      targets.forEach(id => canonical.targets.add(id));
    } else candidates.push({ id: node.id, targets: new Set(targets) });
    buckets.set(key, candidates);
  });

  if (!replacements.size) return {
    nodes: [...graph.nodes], edges: [...graph.edges], groups: [...graph.groups], removedNodeIds: [] as string[],
  };

  const resolve = (id: string) => replacements.get(id) ?? id;
  const mergedIds = new Set(replacements.values());
  const memberships = new Map<string, Set<string>>();
  graph.groups.forEach(group => group.nodeIds.forEach(id => {
    const canonical = resolve(id);
    if (!mergedIds.has(canonical)) return;
    const ids = memberships.get(canonical) ?? new Set<string>();
    ids.add(group.id);
    memberships.set(canonical, ids);
  }));
  // A shared reference should not stretch every scene's bounding box across
  // the canvas. References merged across groups live in the common asset area.
  const sharedIds = new Set([...memberships].filter(([, ids]) => ids.size > 1).map(([id]) => id));
  return {
    nodes: graph.nodes.filter(node => !replacements.has(node.id)),
    edges: graph.edges.map(edge => replacements.has(edge.fromNodeId)
      ? { ...edge, fromNodeId: resolve(edge.fromNodeId) } : edge),
    groups: graph.groups.map(group => ({ ...group,
      nodeIds: [...new Set(group.nodeIds.map(resolve))].filter(id => !sharedIds.has(id)),
    })).filter(group => group.nodeIds.length > 0),
    removedNodeIds: [...replacements.keys()],
  };
}

/** Revert the tidy operation, retaining task updates and new content received
 * while its preview was open. Do not restore unrelated nodes deleted meanwhile. */
export function restoreCanvasAssetArrangement<N extends AssetNode, E extends AssetEdge, G extends AssetGroup>(input: {
  before: Graph<N, E, G>;
  after: Graph<N, E, G>;
  current: Graph<N, E, G>;
}) {
  const { before, after, current } = input;
  const beforeNodes = new Map(before.nodes.map(node => [node.id, node]));
  const afterIds = new Set(after.nodes.map(node => node.id));
  const currentNodes = new Map(current.nodes.map(node => [node.id, node]));
  const nodes = before.nodes.flatMap(node => {
    const now = currentNodes.get(node.id);
    if (now) return [{ ...now, x: node.x, y: node.y }];
    return afterIds.has(node.id) ? [] : [node];
  });
  nodes.push(...current.nodes.filter(node => !beforeNodes.has(node.id)));
  const present = new Set(nodes.map(node => node.id));
  const beforeEdges = new Map(before.edges.map(edge => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map(edge => [edge.id, edge]));
  const edges = current.edges.map(edge => {
    const old = beforeEdges.get(edge.id), arranged = afterEdges.get(edge.id);
    return old && arranged && edge.fromNodeId === arranged.fromNodeId && present.has(old.fromNodeId)
      ? { ...edge, fromNodeId: old.fromNodeId } : edge;
  });
  const beforeGroups = new Map(before.groups.map(group => [group.id, group]));
  const afterGroups = new Map(after.groups.map(group => [group.id, group]));
  const groups = current.groups.map(group => {
    const old = beforeGroups.get(group.id), arranged = afterGroups.get(group.id);
    return old && arranged && JSON.stringify(group.nodeIds) === JSON.stringify(arranged.nodeIds)
      ? { ...group, nodeIds: old.nodeIds.filter(id => present.has(id)) } : group;
  });
  const currentGroupIds = new Set(groups.map(group => group.id));
  groups.push(...before.groups.filter(group => !afterGroups.has(group.id) && !currentGroupIds.has(group.id))
    .map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => present.has(id)) })));
  const restoredGroups = new Map(groups.map(group => [group.id, group]));
  const orderedGroups = before.groups.flatMap(group => {
    const restored = restoredGroups.get(group.id);
    return restored ? [restored] : [];
  });
  orderedGroups.push(...groups.filter(group => !beforeGroups.has(group.id)));
  return { nodes, edges, groups: orderedGroups.filter(group => group.nodeIds.length > 0) };
}
