import {
  readDirectorStudioState,
  type DirectorStudioState,
} from "./studio/types";

export const DIRECTOR_SCENE_V1_VERSION = "director-scene.v1" as const;

export type Vec3 = [number, number, number];
export type Transform3D = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
};
export type DirectorCharacter = {
  id: string;
  name: string;
  bodyType: "male" | "female" | "child";
  height: number;
  color: string;
  transform: Transform3D;
  path: Array<{ timeSeconds: number; position: Vec3 }>;
};
export type DirectorObject = {
  id: string;
  name: string;
  kind: "box" | "sphere" | "cylinder" | "cone" | "plane" | "crowd";
  color: string;
  transform: Transform3D;
};
export type DirectorCamera = {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
};
export type DirectorLight = {
  id: string;
  name: string;
  type: "directional" | "point" | "spot";
  position: Vec3;
  intensity: number;
  color: string;
};
export type DirectorShotBinding = {
  storyboardId: number;
  scriptId: number;
  trackId: number;
  cameraId: string;
  characterIds: string[];
  objectIds: string[];
  notes: string;
};
export type DirectorSceneV1 = {
  version: typeof DIRECTOR_SCENE_V1_VERSION;
  sceneId: string;
  name: string;
  coordinateSystem: "right-handed-y-up";
  unit: "meter";
  durationSeconds: number;
  characters: DirectorCharacter[];
  objects: DirectorObject[];
  cameras: DirectorCamera[];
  lights: DirectorLight[];
  shotBindings: DirectorShotBinding[];
  studio?: DirectorStudioState;
  savedAt: number;
};

export type DirectorSelection =
  | { kind: "character"; id: string }
  | { kind: "object"; id: string }
  | { kind: "camera"; id: string }
  | null;

export type DirectorStoryboardOption = {
  storyboardId: number;
  scriptId: number;
  trackId: number;
  scriptName: string;
  prompt: string;
};

function sceneId(): string {
  return `scene-${crypto.randomUUID()}`;
}

export function entityId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createDefaultDirectorScene(): DirectorSceneV1 {
  return {
    version: DIRECTOR_SCENE_V1_VERSION,
    sceneId: sceneId(),
    name: "未命名 3D 预演",
    coordinateSystem: "right-handed-y-up",
    unit: "meter",
    durationSeconds: 10,
    characters: [{
      id: entityId("character"),
      name: "角色 A",
      bodyType: "male",
      height: 1.75,
      color: "#55b6a8",
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      path: [],
    }],
    objects: [{
      id: entityId("object"),
      name: "场景方块",
      kind: "box",
      color: "#69758a",
      transform: {
        position: [2.5, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    }],
    cameras: [{
      id: entityId("camera"),
      name: "主机位",
      position: [6, 4, 8],
      target: [0, 1, 0],
      fov: 45,
    }],
    lights: [{
      id: entityId("light"),
      name: "主光",
      type: "directional",
      position: [5, 8, 3],
      intensity: 1.2,
      color: "#fff4df",
    }],
    shotBindings: [],
    savedAt: 0,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label}无效`);
  return normalized;
}

function number(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw new Error(`${label}无效`);
  return normalized;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = number(value, label);
  if (normalized < minimum || normalized > maximum) throw new Error(`${label}超出允许范围`);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error(`${label}无效`);
  return normalized;
}

function vec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label}无效`);
  return [
    boundedNumber(value[0], label, -10_000, 10_000),
    boundedNumber(value[1], label, -10_000, 10_000),
    boundedNumber(value[2], label, -10_000, 10_000),
  ];
}

function transform(value: unknown, label: string): Transform3D {
  const source = record(value);
  if (!source) throw new Error(`${label}无效`);
  return {
    position: vec3(source.position, `${label}位置`),
    rotation: vec3(source.rotation, `${label}旋转`).map((entry) => (
      boundedNumber(entry, `${label}旋转`, -1_000, 1_000)
    )) as Vec3,
    scale: vec3(source.scale, `${label}缩放`).map((entry) => (
      boundedNumber(entry, `${label}缩放`, 0.01, 1_000)
    )) as Vec3,
  };
}

function color(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) throw new Error(`${label}无效`);
  return normalized;
}

export function parseDirectorSceneV1(value: unknown): DirectorSceneV1 {
  const source = record(value);
  if (!source || source.version !== DIRECTOR_SCENE_V1_VERSION) {
    throw new Error("不支持的 3D 预演场景版本");
  }
  if (source.coordinateSystem !== "right-handed-y-up" || source.unit !== "meter") {
    throw new Error("3D 预演坐标系或单位不受支持");
  }
  if (!Array.isArray(source.characters) || !Array.isArray(source.objects)
    || !Array.isArray(source.cameras) || !Array.isArray(source.lights)
    || !Array.isArray(source.shotBindings)) {
    throw new Error("3D 预演场景结构无效");
  }
  if (source.characters.length > 60 || source.objects.length > 120
    || source.cameras.length > 30 || source.lights.length > 30
    || source.shotBindings.length > 240) {
    throw new Error("3D 预演场景实体数量超出允许范围");
  }
  const characters = source.characters.map((entry, index): DirectorCharacter => {
    const item = record(entry);
    if (!item) throw new Error(`角色 ${index + 1} 无效`);
    const bodyType = item.bodyType;
    if (bodyType !== "male" && bodyType !== "female" && bodyType !== "child") {
      throw new Error(`角色 ${index + 1} 体型无效`);
    }
    const path = Array.isArray(item.path) ? item.path.map((point, pointIndex) => {
      const keyframe = record(point);
      if (!keyframe) throw new Error(`角色 ${index + 1} 走位 ${pointIndex + 1} 无效`);
      return {
        timeSeconds: boundedNumber(keyframe.timeSeconds, "走位时间", 0, 3_600),
        position: vec3(keyframe.position, "走位位置"),
      };
    }) : [];
    if (path.length > 240) throw new Error(`角色 ${index + 1} 走位关键帧过多`);
    path.forEach((point, pointIndex) => {
      if (pointIndex > 0 && point.timeSeconds <= path[pointIndex - 1].timeSeconds) {
        throw new Error(`角色 ${index + 1} 走位时间必须严格递增`);
      }
    });
    return {
      id: text(item.id, "角色 ID"),
      name: text(item.name, "角色名称"),
      bodyType,
      height: boundedNumber(item.height, "角色身高", 0.5, 3),
      color: color(item.color, "角色颜色"),
      transform: transform(item.transform, "角色变换"),
      path,
    };
  });
  const objects = source.objects.map((entry, index): DirectorObject => {
    const item = record(entry);
    if (!item) throw new Error(`物体 ${index + 1} 无效`);
    const kind = item.kind;
    if (!["box", "sphere", "cylinder", "cone", "plane", "crowd"].includes(String(kind))) {
      throw new Error(`物体 ${index + 1} 类型无效`);
    }
    return {
      id: text(item.id, "物体 ID"),
      name: text(item.name, "物体名称"),
      kind: kind as DirectorObject["kind"],
      color: color(item.color, "物体颜色"),
      transform: transform(item.transform, "物体变换"),
    };
  });
  const cameras = source.cameras.map((entry, index): DirectorCamera => {
    const item = record(entry);
    if (!item) throw new Error(`机位 ${index + 1} 无效`);
    return {
      id: text(item.id, "机位 ID"),
      name: text(item.name, "机位名称"),
      position: vec3(item.position, "机位位置"),
      target: vec3(item.target, "机位目标"),
      fov: boundedNumber(item.fov, "机位 FOV", 10, 120),
    };
  });
  if (!cameras.length) throw new Error("3D 预演至少需要一个机位");
  const lights = source.lights.map((entry, index): DirectorLight => {
    const item = record(entry);
    if (!item) throw new Error(`灯光 ${index + 1} 无效`);
    const type = item.type;
    if (type !== "directional" && type !== "point" && type !== "spot") {
      throw new Error(`灯光 ${index + 1} 类型无效`);
    }
    return {
      id: text(item.id, "灯光 ID"),
      name: text(item.name, "灯光名称"),
      type,
      position: vec3(item.position, "灯光位置"),
      intensity: boundedNumber(item.intensity, "灯光强度", 0, 100),
      color: color(item.color, "灯光颜色"),
    };
  });
  const shotBindings = source.shotBindings.map((entry, index): DirectorShotBinding => {
    const item = record(entry);
    if (!item) throw new Error(`分镜绑定 ${index + 1} 无效`);
    return {
      storyboardId: positiveInteger(item.storyboardId, "分镜 ID"),
      scriptId: positiveInteger(item.scriptId, "剧本 ID"),
      trackId: positiveInteger(item.trackId, "生产轨道 ID"),
      cameraId: text(item.cameraId, "绑定机位"),
      characterIds: Array.isArray(item.characterIds) ? item.characterIds.map((id) => text(id, "角色 ID")) : [],
      objectIds: Array.isArray(item.objectIds) ? item.objectIds.map((id) => text(id, "物体 ID")) : [],
      notes: typeof item.notes === "string" ? item.notes.trim() : "",
    };
  });
  const ensureUnique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`${label} ID 不能重复`);
  };
  ensureUnique(characters.map((item) => item.id), "角色");
  ensureUnique(objects.map((item) => item.id), "物体");
  ensureUnique(cameras.map((item) => item.id), "机位");
  ensureUnique(lights.map((item) => item.id), "灯光");
  if (new Set(shotBindings.map((item) => item.storyboardId)).size !== shotBindings.length) {
    throw new Error("同一分镜只能绑定一份 3D 预演");
  }
  const characterIds = new Set(characters.map((item) => item.id));
  const objectIds = new Set(objects.map((item) => item.id));
  const cameraIds = new Set(cameras.map((item) => item.id));
  shotBindings.forEach((binding) => {
    if (!cameraIds.has(binding.cameraId)
      || binding.characterIds.some((id) => !characterIds.has(id))
      || binding.objectIds.some((id) => !objectIds.has(id))) {
      throw new Error("分镜绑定引用了不存在的场景实体");
    }
    if (binding.notes.length > 1_000) throw new Error("导演备注过长");
  });
  const durationSeconds = boundedNumber(source.durationSeconds, "场景时长", 0.1, 3_600);
  if (characters.some((character) => (
    character.path.some((point) => point.timeSeconds > durationSeconds)
  ))) {
    throw new Error("走位关键帧不能超过场景时长");
  }
  return {
    version: DIRECTOR_SCENE_V1_VERSION,
    sceneId: text(source.sceneId, "场景 ID"),
    name: text(source.name, "场景名称"),
    coordinateSystem: source.coordinateSystem,
    unit: source.unit,
    durationSeconds,
    characters,
    objects,
    cameras,
    lights,
    shotBindings,
    ...(source.studio === undefined ? {} : { studio: readDirectorStudioState(source.studio) }),
    savedAt: Math.max(0, Math.trunc(number(source.savedAt, "保存时间"))),
  };
}

export function hasWebGLSupport(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
