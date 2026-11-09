import type { QuickCreateDirectorPlan, QuickCreateDirectorResource, QuickCreateShot } from "./types";

export type DirectorResourceKind = "character" | "scene" | "asset";

export type DirectorShotPatch = Partial<Pick<QuickCreateShot,
  | "title"
  | "script"
  | "visual"
  | "prompt"
  | "duration"
  | "shotSize"
  | "camera"
  | "movement"
  | "action"
  | "style"
  | "generationMethod"
  | "characterIds"
  | "sceneId"
  | "assetIds"
>>;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function resourceList(plan: QuickCreateDirectorPlan, kind: DirectorResourceKind) {
  if (kind === "character") return plan.characters ?? [];
  if (kind === "scene") return plan.scenes ?? [];
  return plan.assets ?? [];
}

function resourceLabel(resource: QuickCreateDirectorResource) {
  const name = clean(resource.name);
  const description = clean(resource.description);
  return description ? `${name}（${description}）` : name;
}

function selectedResourceLabels(resources: QuickCreateDirectorResource[], ids: string[]) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return ids.map((id) => byId.get(id)).filter((resource): resource is QuickCreateDirectorResource => Boolean(resource))
    .map(resourceLabel).filter(Boolean);
}

export function compileDirectorShotPrompt(shot: QuickCreateShot, plan?: QuickCreateDirectorPlan): string {
  const basePrompt = clean(shot.basePrompt) || clean(shot.prompt) || clean(shot.visual) || clean(shot.script);
  const characterLabels = plan ? selectedResourceLabels(plan.characters ?? [], shot.characterIds ?? []) : [];
  const scene = plan?.scenes?.find((item) => item.id === shot.sceneId);
  const assetLabels = plan ? selectedResourceLabels(plan.assets ?? [], shot.assetIds ?? []) : [];
  const controls = [
    characterLabels.length ? `角色：${characterLabels.join("、")}` : "",
    scene ? `场景：${resourceLabel(scene)}` : "",
    assetLabels.length ? `素材：${assetLabels.join("、")}` : "",
    shot.shotSize ? `景别：${clean(shot.shotSize)}` : "",
    shot.camera ? `机位：${clean(shot.camera)}` : "",
    shot.movement ? `运镜：${clean(shot.movement)}` : "",
    shot.action ? `动作：${clean(shot.action)}` : "",
    shot.style ? `风格：${clean(shot.style)}` : "",
    shot.generationMethod ? `生成方式：${clean(shot.generationMethod)}` : "",
  ].filter(Boolean);
  return [basePrompt, ...controls].filter(Boolean).join("；");
}

export function updateDirectorShot(
  plan: QuickCreateDirectorPlan,
  index: number,
  patch: DirectorShotPatch,
): QuickCreateDirectorPlan {
  if (index < 0 || index >= plan.shots.length) return plan;
  const shots = plan.shots.map((shot, shotIndex) => {
    if (shotIndex !== index) return { ...shot };
    const next = {
      ...shot,
      ...patch,
      title: clean(patch.title ?? shot.title) || shot.title,
      script: clean(patch.script ?? shot.script),
      visual: clean(patch.visual ?? shot.visual),
      duration: Math.min(60, Math.max(1, Number(patch.duration ?? shot.duration) || shot.duration)),
      basePrompt: Object.prototype.hasOwnProperty.call(patch, "prompt")
        ? clean(patch.prompt)
        : clean(shot.basePrompt) || clean(shot.prompt),
    };
    const shouldCompile = ["shotSize", "camera", "movement", "action", "style", "generationMethod", "characterIds", "sceneId", "assetIds"]
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    return {
      ...next,
      characterIds: Array.isArray(next.characterIds) ? [...new Set(next.characterIds.filter(Boolean))] : [],
      assetIds: Array.isArray(next.assetIds) ? [...new Set(next.assetIds.filter(Boolean))] : [],
      sceneId: clean(next.sceneId),
      prompt: shouldCompile ? compileDirectorShotPrompt(next, plan) : clean(patch.prompt ?? shot.prompt),
    };
  });
  return {
    ...plan,
    shots,
    duration: Number(shots.reduce((total, shot) => total + shot.duration, 0).toFixed(3)),
  };
}

function resourceCollectionKey(kind: DirectorResourceKind): "characters" | "scenes" | "assets" {
  if (kind === "character") return "characters";
  if (kind === "scene") return "scenes";
  return "assets";
}

function recompileShots(plan: QuickCreateDirectorPlan): QuickCreateDirectorPlan {
  return {
    ...plan,
    shots: plan.shots.map((shot) => ({ ...shot, prompt: compileDirectorShotPrompt(shot, plan) })),
  };
}

export function addDirectorResource(
  plan: QuickCreateDirectorPlan,
  kind: DirectorResourceKind,
): QuickCreateDirectorPlan {
  const key = resourceCollectionKey(kind);
  const resources = resourceList(plan, kind);
  let suffix = resources.length + 1;
  while (resources.some((resource) => resource.id === `${kind}-${suffix}`)) suffix += 1;
  return {
    ...plan,
    [key]: [...resources.map((resource) => ({ ...resource })), {
      id: `${kind}-${suffix}`,
      name: "",
      description: "",
    }],
  };
}

export function updateDirectorResource(
  plan: QuickCreateDirectorPlan,
  kind: DirectorResourceKind,
  resourceId: string,
  patch: Partial<Pick<QuickCreateDirectorResource, "name" | "description">>,
): QuickCreateDirectorPlan {
  const key = resourceCollectionKey(kind);
  const resources = resourceList(plan, kind);
  if (!resources.some((resource) => resource.id === resourceId)) return plan;
  const next = {
    ...plan,
    [key]: resources.map((resource) => resource.id === resourceId
      ? { ...resource, name: clean(patch.name ?? resource.name), description: clean(patch.description ?? resource.description) }
      : { ...resource }),
  };
  return recompileShots(next);
}

export function removeDirectorResource(
  plan: QuickCreateDirectorPlan,
  kind: DirectorResourceKind,
  resourceId: string,
): QuickCreateDirectorPlan {
  const key = resourceCollectionKey(kind);
  const resources = resourceList(plan, kind);
  if (!resources.some((resource) => resource.id === resourceId)) return plan;
  const next: QuickCreateDirectorPlan = {
    ...plan,
    [key]: resources.filter((resource) => resource.id !== resourceId).map((resource) => ({ ...resource })),
    shots: plan.shots.map((shot) => ({
      ...shot,
      characterIds: kind === "character" ? (shot.characterIds ?? []).filter((id) => id !== resourceId) : [...(shot.characterIds ?? [])],
      sceneId: kind === "scene" && shot.sceneId === resourceId ? "" : shot.sceneId,
      assetIds: kind === "asset" ? (shot.assetIds ?? []).filter((id) => id !== resourceId) : [...(shot.assetIds ?? [])],
    })),
  };
  return recompileShots(next);
}

export function moveDirectorShot(
  plan: QuickCreateDirectorPlan,
  index: number,
  direction: -1 | 1,
): QuickCreateDirectorPlan {
  const target = index + direction;
  if (index < 0 || index >= plan.shots.length || target < 0 || target >= plan.shots.length) return plan;
  const shots = plan.shots.map((shot) => ({ ...shot }));
  [shots[index], shots[target]] = [shots[target], shots[index]];
  return {
    ...plan,
    shots: shots.map((shot, shotIndex) => ({ ...shot, track: `镜头${String(shotIndex + 1).padStart(2, "0")}` })),
  };
}

function renumberDirectorShots(shots: QuickCreateShot[]): QuickCreateShot[] {
  return shots.map((shot, index) => ({
    ...shot,
    track: `镜头${String(index + 1).padStart(2, "0")}`,
  }));
}

function withDirectorShotDuration(
  plan: QuickCreateDirectorPlan,
  shots: QuickCreateShot[],
): QuickCreateDirectorPlan {
  const numbered = renumberDirectorShots(shots);
  return {
    ...plan,
    shots: numbered,
    duration: Number(numbered.reduce((total, shot) => total + shot.duration, 0).toFixed(3)),
  };
}

export function addDirectorShot(plan: QuickCreateDirectorPlan): QuickCreateDirectorPlan {
  const index = plan.shots.length;
  const duration = 5;
  const title = `新分镜 ${index + 1}`;
  return withDirectorShotDuration(plan, [
    ...plan.shots.map((shot) => ({ ...shot })),
    {
      title,
      script: "",
      visual: "",
      prompt: title,
      basePrompt: title,
      duration,
      track: "",
      shotSize: "中景",
      generationMethod: "文生视频",
      characterIds: [],
      sceneId: "",
      assetIds: [],
    },
  ]);
}

export function removeDirectorShot(
  plan: QuickCreateDirectorPlan,
  index: number,
): QuickCreateDirectorPlan {
  if (index < 0 || index >= plan.shots.length) return plan;
  return withDirectorShotDuration(
    plan,
    plan.shots.filter((_, shotIndex) => shotIndex !== index).map((shot) => ({ ...shot })),
  );
}
