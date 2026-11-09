import crypto from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";

export const DIRECTOR_SCENE_V1_VERSION = "director-scene.v1" as const;
export const DIRECTOR_SCENE_V1_DRAFT_KEY = "workbenchDirectorSceneV1";
export const DIRECTOR_SCENE_V1_EPISODE_ID = -9;
export const DIRECTOR_SCENE_V1_MAX_BYTES = 2 * 1024 * 1024;

const finiteNumber = z.number().finite();
const positionValue = finiteNumber.min(-10_000).max(10_000);
const rotationValue = finiteNumber.min(-1_000).max(1_000);
const scaleValue = finiteNumber.min(0.01).max(1_000);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const directorVec3Schema = z.tuple([
  positionValue,
  positionValue,
  positionValue,
]);

const directorRotationSchema = z.tuple([
  rotationValue,
  rotationValue,
  rotationValue,
]);

const directorScaleSchema = z.tuple([
  scaleValue,
  scaleValue,
  scaleValue,
]);

const directorTransformSchema = z.object({
  position: directorVec3Schema,
  rotation: directorRotationSchema,
  scale: directorScaleSchema,
}).strict();

export const directorCharacterSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  bodyType: z.enum(["male", "female", "child"]),
  height: finiteNumber.min(0.5).max(3),
  color: colorSchema,
  transform: directorTransformSchema,
  path: z.array(z.object({
    timeSeconds: finiteNumber.min(0).max(3_600),
    position: directorVec3Schema,
  }).strict()).max(240),
}).strict();

export const directorObjectSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["box", "sphere", "cylinder", "cone", "plane", "crowd"]),
  color: colorSchema,
  transform: directorTransformSchema,
}).strict();

export const directorCameraSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  position: directorVec3Schema,
  target: directorVec3Schema,
  fov: finiteNumber.min(10).max(120),
}).strict();

export const directorLightSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["directional", "point", "spot"]),
  position: directorVec3Schema,
  intensity: finiteNumber.min(0).max(100),
  color: colorSchema,
}).strict();

export const directorShotBindingSchema = z.object({
  storyboardId: z.number().int().positive(),
  scriptId: z.number().int().positive(),
  trackId: z.number().int().positive(),
  cameraId: z.string().trim().min(1).max(100),
  characterIds: z.array(z.string().trim().min(1).max(100)).max(60),
  objectIds: z.array(z.string().trim().min(1).max(100)).max(120),
  notes: z.string().trim().max(1_000),
}).strict();

const directorCharacterModelSchema = z.enum([
  "adult-male",
  "adult-female",
  "teenager",
  "young-child",
  "slender",
  "broad",
  "chibi",
  "muscular",
]);

const directorPosePresetSchema = z.enum([
  "standing",
  "t-pose",
  "walking",
  "running",
  "sitting",
  "crouching",
  "kneeling-one",
  "kneeling-both",
  "hands-on-hips",
  "leaning",
  "bowing",
  "thinking",
  "fighting",
  "kicking",
  "throwing",
  "pushing",
  "waving",
  "stretching",
  "arms-crossed",
  "phone",
]);

const poseAngle = finiteNumber.min(-360).max(360);
const directorPoseAdjustmentsSchema = z.object({
  bodyPitch: poseAngle,
  bodyTurn: poseAngle,
  bodyRoll: poseAngle,
  torsoPitch: poseAngle,
  torsoTwist: poseAngle,
  torsoRoll: poseAngle,
  headNod: poseAngle,
  headTurn: poseAngle,
  headTilt: poseAngle,
  leftShoulderForward: poseAngle,
  leftShoulderOut: poseAngle,
  leftShoulderTwist: poseAngle,
  rightShoulderForward: poseAngle,
  rightShoulderOut: poseAngle,
  rightShoulderTwist: poseAngle,
  leftElbowBend: poseAngle,
  rightElbowBend: poseAngle,
  leftHipForward: poseAngle,
  leftHipOut: poseAngle,
  leftHipTwist: poseAngle,
  rightHipForward: poseAngle,
  rightHipOut: poseAngle,
  rightHipTwist: poseAngle,
  leftKneeBend: poseAngle,
  rightKneeBend: poseAngle,
}).strict();

const directorQuaternionSchema = z.tuple([
  finiteNumber.min(-1).max(1),
  finiteNumber.min(-1).max(1),
  finiteNumber.min(-1).max(1),
  finiteNumber.min(-1).max(1),
]);

const directorPoseJointRotationsSchema = z.object({
  head: directorQuaternionSchema.optional(),
  chest: directorQuaternionSchema.optional(),
  pelvis: directorQuaternionSchema.optional(),
  root: directorQuaternionSchema.optional(),
  leftShoulder: directorQuaternionSchema.optional(),
  leftElbow: directorQuaternionSchema.optional(),
  leftHand: directorQuaternionSchema.optional(),
  rightShoulder: directorQuaternionSchema.optional(),
  rightElbow: directorQuaternionSchema.optional(),
  rightHand: directorQuaternionSchema.optional(),
  leftHip: directorQuaternionSchema.optional(),
  leftKnee: directorQuaternionSchema.optional(),
  leftAnkle: directorQuaternionSchema.optional(),
  rightHip: directorQuaternionSchema.optional(),
  rightKnee: directorQuaternionSchema.optional(),
  rightAnkle: directorQuaternionSchema.optional(),
}).strict();

const directorStudioObjectSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["character", "cube", "sphere", "crowd", "camera"]),
  color: colorSchema,
  position: directorVec3Schema,
  rotation: directorRotationSchema,
  scale: z.tuple([
    finiteNumber.min(0.1).max(10),
    finiteNumber.min(0.1).max(10),
    finiteNumber.min(0.1).max(10),
  ]),
  uniformScale: finiteNumber.min(0.1).max(5),
  visible: z.boolean(),
  characterModel: directorCharacterModelSchema.optional(),
  posePreset: directorPosePresetSchema.optional(),
  poseAdjustments: directorPoseAdjustmentsSchema.optional(),
  poseJointRotations: directorPoseJointRotationsSchema.optional(),
  cameraFov: finiteNumber.min(20).max(100).optional(),
  cameraTargetObjectId: z.string().trim().min(1).max(100).nullable().optional(),
  cameraTargetPosition: directorVec3Schema.optional(),
}).strict();

const directorStudioStateSchema = z.object({
  objects: z.array(directorStudioObjectSchema).min(1).max(240),
  cameraSetupInitialized: z.literal(true),
  scene: z.object({
    viewScaleInitialized: z.literal(true),
    scale: finiteNumber.min(0.2).max(30),
    position: directorVec3Schema,
    rotation: directorRotationSchema,
    skyColor: colorSchema,
    panoramaRotation: finiteNumber.min(-180).max(180),
    panoramaRadius: finiteNumber.min(10).max(120),
    showCharacterLabels: z.boolean(),
    snapToGrid: z.boolean(),
    snapToGround: z.boolean(),
    groundVisible: z.boolean(),
    groundOpacity: finiteNumber.min(0).max(1),
  }).strict(),
  camera: z.object({
    position: directorVec3Schema,
    fov: finiteNumber.min(20).max(100),
    targetObjectId: z.string().trim().min(1).max(100).nullable(),
    targetPosition: directorVec3Schema,
  }).strict(),
  captureRatio: z.enum(["16:9", "9:16", "1:1", "4:3"]),
}).strict();

export const directorSceneV1Schema = z.object({
  version: z.literal(DIRECTOR_SCENE_V1_VERSION),
  sceneId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(160),
  coordinateSystem: z.literal("right-handed-y-up"),
  unit: z.literal("meter"),
  durationSeconds: finiteNumber.min(0.1).max(3_600),
  characters: z.array(directorCharacterSchema).max(60),
  objects: z.array(directorObjectSchema).max(120),
  cameras: z.array(directorCameraSchema).min(1).max(30),
  lights: z.array(directorLightSchema).max(30),
  shotBindings: z.array(directorShotBindingSchema).max(240),
  studio: directorStudioStateSchema.optional(),
  savedAt: z.number().int().nonnegative(),
}).strict().superRefine((scene, context) => {
  const ensureUnique = (values: string[], path: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [path, index, "id"],
          message: "场景实体 ID 不能重复",
        });
      }
      seen.add(value);
    });
    return seen;
  };

  const characterIds = ensureUnique(scene.characters.map((item) => item.id), "characters");
  const objectIds = ensureUnique(scene.objects.map((item) => item.id), "objects");
  const cameraIds = ensureUnique(scene.cameras.map((item) => item.id), "cameras");
  ensureUnique(scene.lights.map((item) => item.id), "lights");

  if (scene.studio) {
    const studioIds = new Set<string>();
    scene.studio.objects.forEach((object, index) => {
      if (studioIds.has(object.id)) {
        context.addIssue({
          code: "custom",
          path: ["studio", "objects", index, "id"],
          message: "导演台对象 ID 不能重复",
        });
      }
      studioIds.add(object.id);
    });
    scene.studio.objects.forEach((object, index) => {
      if (object.cameraTargetObjectId && !studioIds.has(object.cameraTargetObjectId)) {
        context.addIssue({
          code: "custom",
          path: ["studio", "objects", index, "cameraTargetObjectId"],
          message: "机位目标不存在",
        });
      }
    });
    if (scene.studio.camera.targetObjectId && !studioIds.has(scene.studio.camera.targetObjectId)) {
      context.addIssue({
        code: "custom",
        path: ["studio", "camera", "targetObjectId"],
        message: "导演视角目标不存在",
      });
    }
    const expectedCharacters = new Set(scene.studio.objects.filter((item) => item.kind === "character").map((item) => item.id));
    const expectedObjects = new Set(scene.studio.objects.filter((item) => ["cube", "sphere", "crowd"].includes(item.kind)).map((item) => item.id));
    const expectedCameras = new Set(scene.studio.objects.filter((item) => item.kind === "camera").map((item) => item.id));
    const sameIds = (actual: Set<string>, expected: Set<string>) => (
      actual.size === expected.size && [...actual].every((id) => expected.has(id))
    );
    if (!sameIds(characterIds, expectedCharacters)) {
      context.addIssue({ code: "custom", path: ["characters"], message: "角色与导演台状态不一致" });
    }
    if (!sameIds(objectIds, expectedObjects)) {
      context.addIssue({ code: "custom", path: ["objects"], message: "场景物体与导演台状态不一致" });
    }
    if (!sameIds(cameraIds, expectedCameras)) {
      context.addIssue({ code: "custom", path: ["cameras"], message: "机位与导演台状态不一致" });
    }

    const studioById = new Map(scene.studio.objects.map((item) => [item.id, item]));
    const sameVector = (actual: readonly number[], expected: readonly number[]) => (
      actual.length === expected.length && actual.every((value, index) => value === expected[index])
    );
    const scaledStudioVector = (object: (typeof scene.studio.objects)[number]) => (
      object.scale.map((value) => Number((value * object.uniformScale).toFixed(6)))
    );
    const bodyTypeByModel: Record<string, "male" | "female" | "child"> = {
      "adult-male": "male",
      "adult-female": "female",
      teenager: "child",
      "young-child": "child",
      slender: "male",
      broad: "male",
      chibi: "child",
      muscular: "male",
    };
    scene.characters.forEach((character, index) => {
      const source = studioById.get(character.id);
      const expectedScale = source ? scaledStudioVector(source) : [];
      const expectedHeight = source ? Math.min(3, Math.max(0.5, 1.75 * source.uniformScale)) : 0;
      if (
        !source || source.kind !== "character"
        || character.name !== source.name
        || character.color.toLowerCase() !== source.color.toLowerCase()
        || character.bodyType !== bodyTypeByModel[source.characterModel || "adult-male"]
        || character.height !== expectedHeight
        || !sameVector(character.transform.position, source.position)
        || !sameVector(character.transform.rotation, source.rotation)
        || !sameVector(character.transform.scale, expectedScale)
      ) {
        context.addIssue({
          code: "custom",
          path: ["characters", index],
          message: "角色生产投影与导演台状态不一致",
        });
      }
    });
    scene.objects.forEach((object, index) => {
      const source = studioById.get(object.id);
      const expectedKind = source?.kind === "cube" ? "box" : source?.kind;
      const expectedScale = source ? scaledStudioVector(source) : [];
      if (
        !source || !["cube", "sphere", "crowd"].includes(source.kind)
        || object.name !== source.name
        || object.kind !== expectedKind
        || object.color.toLowerCase() !== source.color.toLowerCase()
        || !sameVector(object.transform.position, source.position)
        || !sameVector(object.transform.rotation, source.rotation)
        || !sameVector(object.transform.scale, expectedScale)
      ) {
        context.addIssue({
          code: "custom",
          path: ["objects", index],
          message: "场景物体生产投影与导演台状态不一致",
        });
      }
    });
    scene.cameras.forEach((camera, index) => {
      const source = studioById.get(camera.id);
      const targetObject = source?.cameraTargetObjectId
        ? studioById.get(source.cameraTargetObjectId)
        : null;
      const expectedTarget = targetObject
        ? [targetObject.position[0], targetObject.position[1] + 1, targetObject.position[2]]
        : source?.cameraTargetPosition || scene.studio!.camera.targetPosition;
      if (
        !source || source.kind !== "camera"
        || camera.name !== source.name
        || camera.fov !== (source.cameraFov || scene.studio!.camera.fov)
        || !sameVector(camera.position, source.position)
        || !sameVector(camera.target, expectedTarget)
      ) {
        context.addIssue({
          code: "custom",
          path: ["cameras", index],
          message: "机位生产投影与导演台状态不一致",
        });
      }
    });
  }

  const storyboardIds = new Set<number>();
  scene.characters.forEach((character, characterIndex) => {
    let previousTime = -1;
    character.path.forEach((keyframe, pathIndex) => {
      if (keyframe.timeSeconds > scene.durationSeconds) {
        context.addIssue({
          code: "custom",
          path: ["characters", characterIndex, "path", pathIndex, "timeSeconds"],
          message: "走位关键帧不能超过场景时长",
        });
      }
      if (keyframe.timeSeconds <= previousTime) {
        context.addIssue({
          code: "custom",
          path: ["characters", characterIndex, "path", pathIndex, "timeSeconds"],
          message: "走位关键帧时间必须严格递增",
        });
      }
      previousTime = keyframe.timeSeconds;
    });
  });

  scene.shotBindings.forEach((binding, bindingIndex) => {
    if (storyboardIds.has(binding.storyboardId)) {
      context.addIssue({
        code: "custom",
        path: ["shotBindings", bindingIndex, "storyboardId"],
        message: "同一分镜只能绑定一份 3D 预演",
      });
    }
    storyboardIds.add(binding.storyboardId);
    if (!cameraIds.has(binding.cameraId)) {
      context.addIssue({
        code: "custom",
        path: ["shotBindings", bindingIndex, "cameraId"],
        message: "绑定的机位不存在",
      });
    }
    binding.characterIds.forEach((id, index) => {
      if (!characterIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["shotBindings", bindingIndex, "characterIds", index],
          message: "绑定的角色不存在",
        });
      }
    });
    binding.objectIds.forEach((id, index) => {
      if (!objectIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["shotBindings", bindingIndex, "objectIds", index],
          message: "绑定的场景物体不存在",
        });
      }
    });
  });
});

export type DirectorSceneV1 = z.infer<typeof directorSceneV1Schema>;

export class DirectorSceneBindingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectorSceneBindingError";
  }
}

export class DirectorSceneStorageError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectorSceneStorageError";
  }
}

export function directorSceneDigest(scene: DirectorSceneV1): string {
  return crypto.createHash("sha256").update(JSON.stringify(scene)).digest("hex");
}

export async function validateDirectorSceneBindings(
  database: Knex | Knex.Transaction,
  projectId: number,
  scene: DirectorSceneV1,
): Promise<void> {
  if (!scene.shotBindings.length) return;
  const storyboardIds = scene.shotBindings.map((binding) => binding.storyboardId);
  const rows = await database("o_storyboard")
    .where({ projectId })
    .whereIn("id", storyboardIds)
    .select("id", "scriptId", "trackId");
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const binding of scene.shotBindings) {
    const row = byId.get(binding.storyboardId);
    if (!row) {
      throw new DirectorSceneBindingError(
        404,
        "director_storyboard_not_found",
        "分镜不存在或不属于当前项目",
      );
    }
    if (
      Number(row.scriptId) !== binding.scriptId
      || Number(row.trackId) !== binding.trackId
    ) {
      throw new DirectorSceneBindingError(
        409,
        "director_storyboard_binding_stale",
        "分镜与剧本或生产轨道的绑定已变化，请刷新后重试",
      );
    }
  }
}

export async function loadDirectorSceneV1(
  database: Knex | Knex.Transaction,
  projectId: number,
): Promise<DirectorSceneV1 | null> {
  const row = await database("o_agentWorkData")
    .where({
      projectId,
      episodesId: DIRECTOR_SCENE_V1_EPISODE_ID,
      key: DIRECTOR_SCENE_V1_DRAFT_KEY,
    })
    .select("data")
    .first();
  if (!row?.data) return null;
  try {
    const parsed = directorSceneV1Schema.safeParse(JSON.parse(String(row.data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formatVec3(value: readonly number[]): string {
  return value.map((item) => Number(item.toFixed(3))).join(", ");
}

export type DirectorTrackConstraint = {
  version: typeof DIRECTOR_SCENE_V1_VERSION;
  digest: string;
  savedAt: number;
  storyboardIds: number[];
  text: string;
};

export function buildDirectorTrackConstraint(
  scene: DirectorSceneV1,
  scriptId: number,
  trackId: number,
): DirectorTrackConstraint | null {
  const bindings = scene.shotBindings
    .filter((binding) => binding.scriptId === scriptId && binding.trackId === trackId)
    .sort((left, right) => left.storyboardId - right.storyboardId);
  if (!bindings.length) return null;
  const cameras = new Map(scene.cameras.map((camera) => [camera.id, camera]));
  const characters = new Map(scene.characters.map((character) => [character.id, character]));
  const objects = new Map(scene.objects.map((object) => [object.id, object]));
  const studioObjects = new Map((scene.studio?.objects || []).map((object) => [object.id, object]));
  const lines = [
    "[3D预演约束：来自项目内已保存的 director-scene.v1，不得忽略]",
    `场景：${scene.name}；坐标系：右手/Y 轴向上；单位：米；场景时长：${scene.durationSeconds} 秒${scene.studio ? `；取景比例：${scene.studio.captureRatio}` : ""}。`,
  ];
  bindings.forEach((binding) => {
    const camera = cameras.get(binding.cameraId);
    if (!camera) return;
    lines.push(
      `分镜 ${binding.storyboardId}：机位「${camera.name}」，位置 (${formatVec3(camera.position)})，目标 (${formatVec3(camera.target)})，FOV ${camera.fov}°。`,
    );
    binding.characterIds.forEach((characterId) => {
      const character = characters.get(characterId);
      if (!character) return;
      const studioCharacter = studioObjects.get(characterId);
      if (studioCharacter?.visible === false) return;
      const path = character.path.length
        ? `；走位 ${character.path.map((point) => `${point.timeSeconds}s@(${formatVec3(point.position)})`).join(" -> ")}`
        : "";
      const pose = studioCharacter?.kind === "character"
        ? `；角色模型 ${studioCharacter.characterModel || "adult-male"}；姿势 ${studioCharacter.posePreset || "standing"}`
        : "";
      lines.push(
        `角色「${character.name}」位置 (${formatVec3(character.transform.position)})，朝向 (${formatVec3(character.transform.rotation)})${pose}${path}。`,
      );
    });
    binding.objectIds.forEach((objectId) => {
      const object = objects.get(objectId);
      if (!object) return;
      if (studioObjects.get(objectId)?.visible === false) return;
      lines.push(
        `场景物体「${object.name}」(${object.kind}) 位置 (${formatVec3(object.transform.position)})，缩放 (${formatVec3(object.transform.scale)})。`,
      );
    });
    if (binding.notes) lines.push(`导演备注：${binding.notes}`);
  });
  return {
    version: DIRECTOR_SCENE_V1_VERSION,
    digest: directorSceneDigest(scene),
    savedAt: scene.savedAt,
    storyboardIds: bindings.map((binding) => binding.storyboardId),
    text: lines.join("\n"),
  };
}
