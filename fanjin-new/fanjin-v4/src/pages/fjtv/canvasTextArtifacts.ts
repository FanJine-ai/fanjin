export const ARTIFACT_KINDS = ["characters", "scenes", "props", "shots"] as const;
export type CanvasArtifactKind = typeof ARTIFACT_KINDS[number];
export const ARTIFACT_LABELS: Record<CanvasArtifactKind, string> = {
  characters: "角色", scenes: "场景", props: "道具", shots: "分镜",
};

export function buildCanvasArtifactImagePrompt(prompts: string[], kinds: CanvasArtifactKind[]): string {
  const selectedKinds = [...new Set(kinds)];
  const instructions: Record<CanvasArtifactKind, string> = {
    characters: "请生成一张角色设定图。以以下角色资料为依据绘制人物，突出外貌、服装和标志性道具。输出图片，不要输出文字说明。",
    scenes: "请生成一张场景设定图。以以下场景资料为依据绘制环境，突出空间布局、建筑、光线和氛围。画面只表现环境和空间，不要出现人物、人体、动物、路人或角色肖像，不要把剧情事件画成动作场面。输出图片，不要输出文字说明。",
    props: "请生成一张道具设定图。以以下道具资料为依据绘制物品，突出形状、材质、颜色和特殊细节。输出图片，不要输出文字说明。",
    shots: "请生成一张分镜图。只绘制当前分镜的一个关键帧，遵循机位、构图和光线。关联设定仅用于保持外观一致，不要绘制其他分镜或时间点。输出图片，不要输出文字说明。",
  };
  if (!selectedKinds.length || !prompts.length) return "";
  const kind = selectedKinds.length === 1 ? selectedKinds[0] : undefined;
  const instruction = kind ? instructions[kind]
    : "请生成一张图片。以以下选中的视觉素材资料为依据绘制画面，结合提供的参考图保持对象一致。输出图片，不要输出文字说明。";
  if (kind === "shots") return `${instruction}\n\n${prompts.join("\n\n")}`;
  const label = kind ? `${ARTIFACT_LABELS[kind]}资料：` : "视觉素材资料：";
  return `${instruction}\n\n${label}\n${prompts.join("\n\n")}`;
}

export interface CanvasArtifactResult {
  name: string;
  description: string;
  evidence: string;
  assumptions: string;
  characterIds: string[];
  sceneIds: string[];
  propIds: string[];
}

export interface CanvasArtifactReference {
  nodeId: string;
  assetVersionId: number;
  imageUrl: string;
  referenceAssetUri?: string;
}

export interface CanvasArtifactCard extends CanvasArtifactResult {
  id: string;
  sourceName: string;
  reference?: CanvasArtifactReference;
}

export interface CanvasArtifactCollection {
  cards: CanvasArtifactCard[];
  sourceText: string;
}

export type CanvasTextArtifacts = Partial<Record<CanvasArtifactKind, CanvasArtifactCollection>>;
export interface CanvasArtifactBinding { sourceNodeId: string; cardId: string }
export interface CanvasArtifactContext {
  id: string;
  kind: Exclude<CanvasArtifactKind, "shots">;
  name: string;
  description: string;
}
export interface CanvasTextRequest {
  prompt: string;
  model: string;
  operation?: CanvasArtifactKind;
  instruction?: string;
  context?: CanvasArtifactContext[];
}
export interface CanvasArtifactNodeFields {
  textArtifacts?: CanvasTextArtifacts;
  textArtifactTab?: "body" | CanvasArtifactKind;
  textArtifactInstruction?: string;
  textArtifactBindings?: CanvasArtifactBinding[];
  textArtifactSourceModes?: Record<string, "body" | "cards">;
  artifactImageTarget?: CanvasArtifactBinding;
  textRequestAttempt?: { id: string; payload: CanvasTextRequest };
  textGenerationAttemptId?: string;
  artifactRevision?: number;
  textContentVersion?: number;
}

export function allArtifactCards(artifacts?: CanvasTextArtifacts) {
  return ARTIFACT_KINDS.flatMap((kind) => (artifacts?.[kind]?.cards || []).map((card) => ({ kind, card })));
}

export function canvasArtifactContext(artifacts?: CanvasTextArtifacts): CanvasArtifactContext[] {
  return allArtifactCards(artifacts).flatMap(({ kind, card }) => kind === "shots" ? [] : [{
    kind, id: card.id, name: card.name, description: card.description,
  }]);
}

export function reconcileArtifactCards(previous: CanvasArtifactCard[], results: CanvasArtifactResult[], createId: () => string, protectedIds: ReadonlySet<string> = new Set()) {
  const used = new Set<string>();
  const key = (name: string) => name.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
  const next = results.map((result) => {
    const existing = previous.find((card) => !used.has(card.id) && (key(card.sourceName) === key(result.name) || key(card.name) === key(result.name)));
    if (existing) used.add(existing.id);
    return {
      ...result, id: existing?.id || createId(), sourceName: result.name,
      ...(existing?.reference ? { reference: existing.reference } : {}),
    };
  });
  return [...next, ...previous.filter((card) => !used.has(card.id) && (protectedIds.has(card.id) || Boolean(card.reference)))];
}

export function preserveNewerArtifactState<T extends CanvasArtifactNodeFields>(local: T, patch: Partial<T>): Partial<T> {
  const result = { ...patch };
  if ((local.artifactRevision || 0) > (patch.artifactRevision || 0)) {
    for (const key of ["textArtifacts", "textArtifactTab", "textArtifactInstruction", "textArtifactBindings", "textArtifactSourceModes", "artifactImageTarget", "textRequestAttempt", "textGenerationAttemptId", "artifactRevision"] as const) {
      delete result[key];
    }
  }
  if ((local.textContentVersion || 0) > (patch.textContentVersion || 0)) {
    delete (result as Record<string, unknown>).outputText;
    delete result.textContentVersion;
  }
  return result;
}

export function remapCanvasArtifactNode<T extends CanvasArtifactNodeFields>(node: T, nodeIds: Map<string, string>): T {
  const remapBinding = (binding: CanvasArtifactBinding) => ({ ...binding, sourceNodeId: nodeIds.get(binding.sourceNodeId) || binding.sourceNodeId });
  return {
    ...node,
    ...(node.textArtifactBindings ? { textArtifactBindings: node.textArtifactBindings.map(remapBinding) } : {}),
    ...(node.artifactImageTarget ? { artifactImageTarget: remapBinding(node.artifactImageTarget) } : {}),
    ...(node.textArtifactSourceModes ? { textArtifactSourceModes: Object.fromEntries(Object.entries(node.textArtifactSourceModes).map(([sourceId, mode]) => [nodeIds.get(sourceId) || sourceId, mode])) } : {}),
    ...(node.textArtifacts ? { textArtifacts: Object.fromEntries(ARTIFACT_KINDS.flatMap((kind) => {
      const collection = node.textArtifacts?.[kind];
      return collection ? [[kind, { ...collection, cards: collection.cards.map((card) => ({
        ...card,
        ...(card.reference ? { reference: { ...card.reference, nodeId: nodeIds.get(card.reference.nodeId) || card.reference.nodeId } } : {}),
      })) }]] : [];
    })) } : {}),
  };
}

export function resolveCanvasArtifactInputs(input: {
  sources: Array<{ id: string; textArtifacts?: CanvasTextArtifacts; text: string }>;
  bindings?: CanvasArtifactBinding[];
  modes?: Record<string, "body" | "cards">;
  requireShotReferences?: boolean;
}) {
  const prompts: string[] = [];
  const references: CanvasArtifactReference[] = [];
  const errors: string[] = [];
  const selectedKinds: CanvasArtifactKind[] = [];
  const imageEntries: Array<{ kind: CanvasArtifactKind; card: CanvasArtifactCard }> = [];
  const bodyPrompts: string[] = [];
  let usesCards = false;
  const sourceIds = new Set(input.sources.map((source) => source.id));
  for (const binding of input.bindings || []) {
    if (!sourceIds.has(binding.sourceNodeId)) errors.push("选中的卡片来源已断开连接，请重新连接或清除选择");
  }
  for (const source of input.sources) {
    const entries = allArtifactCards(source.textArtifacts);
    const bindings = (input.bindings || []).filter((binding) => binding.sourceNodeId === source.id);
    const mode = input.modes?.[source.id] || (entries.length || bindings.length ? "cards" : "body");
    if (mode === "body") {
      if (source.text.trim()) {
        prompts.push(source.text.trim());
        bodyPrompts.push(source.text.trim());
      }
      continue;
    }
    usesCards = true;
    if (!bindings.length) {
      errors.push("请在文本素材中选择要生成的卡片，或切换为引用正文");
      continue;
    }
    const included = new Set<string>();
    const include = (id: string, expectedKind?: CanvasArtifactKind) => {
      const entry = entries.find((entry) => entry.card.id === id && (!expectedKind || expectedKind === entry.kind));
      if (!entry) { errors.push("选中的卡片或分镜关联对象已不存在，请重新选择"); return; }
      if (included.has(id)) return;
      included.add(id);
      const { kind, card } = entry;
      imageEntries.push(entry);
      if (!card.name.trim() || !card.description.trim()) errors.push("卡片名称和画面描述不能为空，请先补充");
      prompts.push(`${ARTIFACT_LABELS[kind]}「${card.name}」：${card.description}`);
      if (card.reference) {
        if (!Number.isSafeInteger(card.reference.assetVersionId) || card.reference.assetVersionId <= 0 || !card.reference.imageUrl) {
          errors.push(`「${card.name}」的参考图尚未入库，请重新设置`);
        } else references.push(card.reference);
      }
      if (kind === "shots") {
        if (input.requireShotReferences) {
          const dependencies = [...card.characterIds, ...card.sceneIds, ...card.propIds];
          if (!dependencies.length && !card.reference) errors.push(`分镜「${card.name}」尚未关联参考图，请先关联角色、场景或道具`);
          for (const dependencyId of dependencies) {
            const dependency = entries.find((item) => item.card.id === dependencyId);
            if (dependency && !dependency.card.reference) errors.push(`分镜「${card.name}」缺少「${dependency.card.name}」参考图，请先生成并确认设定图`);
          }
        }
        for (const dependency of card.characterIds) include(dependency, "characters");
        for (const dependency of card.sceneIds) include(dependency, "scenes");
        for (const dependency of card.propIds) include(dependency, "props");
      }
    };
    bindings.forEach((binding) => {
      const selected = entries.find((entry) => entry.card.id === binding.cardId);
      if (selected) selectedKinds.push(selected.kind);
      include(binding.cardId);
    });
  }
  const uniqueReferences = references.filter((reference, index) => references.findIndex((other) => other.assetVersionId === reference.assetVersionId) === index);
  const imagePromptForReferences = (assetVersionIds: number[]) => {
    if (!usesCards) return "";
    if (!selectedKinds.length || selectedKinds.some((kind) => kind !== "shots")) {
      return buildCanvasArtifactImagePrompt(prompts, selectedKinds);
    }
    const shotPrompts = imageEntries.map(({ kind, card }) => {
      if (kind === "shots") return `当前分镜：${card.description}`;
      const referenceIndex = card.reference ? assetVersionIds.indexOf(card.reference.assetVersionId) : -1;
      return referenceIndex >= 0
        ? `参考图${referenceIndex + 1}：${ARTIFACT_LABELS[kind]}「${card.name}」，使用已确认参考图中的外观。`
        : `${ARTIFACT_LABELS[kind]}「${card.name}」：${card.description}`;
    });
    return buildCanvasArtifactImagePrompt([...shotPrompts, ...bodyPrompts], selectedKinds);
  };
  return {
    prompts, usesCards, errors: [...new Set(errors)],
    imagePrompt: imagePromptForReferences(uniqueReferences.map((reference) => reference.assetVersionId)),
    imagePromptForReferences,
    references: uniqueReferences,
  };
}
