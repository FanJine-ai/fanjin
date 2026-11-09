import type {
  DirectorCamera,
  DirectorCharacter,
  DirectorObject as DirectorSceneObject,
  DirectorSceneV1,
  DirectorShotBinding,
  Vec3,
} from "./directorScene";
import { getUprightCameraRotation } from "./studio/camera-orientation";
import {
  createInitialDirectorStudioState,
  getDirectorPoseAdjustments,
  readDirectorStudioState,
  type DirectorCharacterModel,
  type DirectorObject as StudioObject,
  type DirectorStudioState,
} from "./studio/types";

const BODY_TYPE_BY_MODEL: Record<DirectorCharacterModel, DirectorCharacter["bodyType"]> = {
  "adult-male": "male",
  "adult-female": "female",
  teenager: "child",
  "young-child": "child",
  slender: "male",
  broad: "male",
  chibi: "child",
  muscular: "male",
};

function modelForBodyType(bodyType: DirectorCharacter["bodyType"]): DirectorCharacterModel {
  if (bodyType === "female") return "adult-female";
  if (bodyType === "child") return "young-child";
  return "adult-male";
}

function scaledVector(object: StudioObject): Vec3 {
  const uniformScale = Number.isFinite(object.uniformScale) ? object.uniformScale : 1;
  return object.scale.map((entry) => Number((entry * uniformScale).toFixed(6))) as Vec3;
}

function cameraTarget(studio: DirectorStudioState, object: StudioObject): Vec3 {
  const target = object.cameraTargetObjectId
    ? studio.objects.find((candidate) => candidate.id === object.cameraTargetObjectId)
    : null;
  if (target) {
    return [target.position[0], target.position[1] + 1, target.position[2]];
  }
  return [...(object.cameraTargetPosition || studio.camera.targetPosition)] as Vec3;
}

function normalizeBindings(
  bindings: DirectorShotBinding[],
  characters: DirectorCharacter[],
  objects: DirectorSceneObject[],
  cameras: DirectorCamera[],
): DirectorShotBinding[] {
  const characterIds = new Set(characters.map((item) => item.id));
  const objectIds = new Set(objects.map((item) => item.id));
  const cameraIds = new Set(cameras.map((item) => item.id));
  return bindings
    .filter((binding) => cameraIds.has(binding.cameraId))
    .map((binding) => ({
      ...binding,
      characterIds: binding.characterIds.filter((id) => characterIds.has(id)),
      objectIds: binding.objectIds.filter((id) => objectIds.has(id)),
    }));
}

export function directorSceneFromStudio(
  current: DirectorSceneV1,
  source: DirectorStudioState,
): DirectorSceneV1 {
  const studio = readDirectorStudioState(source);
  const previousCharacters = new Map(current.characters.map((item) => [item.id, item]));
  const characters: DirectorCharacter[] = studio.objects
    .filter((object) => object.kind === "character")
    .map((object) => ({
      id: object.id,
      name: object.name,
      bodyType: BODY_TYPE_BY_MODEL[object.characterModel || "adult-male"],
      height: Math.min(3, Math.max(0.5, 1.75 * object.uniformScale)),
      color: object.color,
      transform: {
        position: [...object.position] as Vec3,
        rotation: [...object.rotation] as Vec3,
        scale: scaledVector(object),
      },
      path: previousCharacters.get(object.id)?.path || [],
    }));
  const objects: DirectorSceneObject[] = studio.objects
    .filter((object): object is StudioObject & { kind: "cube" | "sphere" | "crowd" } => (
      object.kind === "cube" || object.kind === "sphere" || object.kind === "crowd"
    ))
    .map((object) => ({
      id: object.id,
      name: object.name,
      kind: object.kind === "cube" ? "box" : object.kind,
      color: object.color,
      transform: {
        position: [...object.position] as Vec3,
        rotation: [...object.rotation] as Vec3,
        scale: scaledVector(object),
      },
    }));
  const cameras: DirectorCamera[] = studio.objects
    .filter((object) => object.kind === "camera")
    .map((object) => ({
      id: object.id,
      name: object.name,
      position: [...object.position] as Vec3,
      target: cameraTarget(studio, object),
      fov: object.cameraFov || studio.camera.fov,
    }));

  return {
    ...current,
    characters,
    objects,
    cameras,
    shotBindings: normalizeBindings(current.shotBindings, characters, objects, cameras),
    studio,
  };
}

export function studioFromDirectorScene(scene: DirectorSceneV1): DirectorStudioState {
  if (scene.studio) return readDirectorStudioState(scene.studio);
  const fallback = createInitialDirectorStudioState();
  const objects: StudioObject[] = [
    ...scene.characters.map((character): StudioObject => ({
      id: character.id,
      name: character.name,
      kind: "character",
      color: character.color,
      position: [...character.transform.position] as Vec3,
      rotation: [...character.transform.rotation] as Vec3,
      scale: [...character.transform.scale] as Vec3,
      uniformScale: Math.min(5, Math.max(0.1, character.height / 1.75)),
      visible: true,
      characterModel: modelForBodyType(character.bodyType),
      posePreset: "standing",
      poseAdjustments: getDirectorPoseAdjustments("standing"),
      poseJointRotations: {},
    })),
    ...scene.objects.map((object): StudioObject => ({
      id: object.id,
      name: object.name,
      kind: object.kind === "sphere" ? "sphere" : object.kind === "crowd" ? "crowd" : "cube",
      color: object.color,
      position: [...object.transform.position] as Vec3,
      rotation: [...object.transform.rotation] as Vec3,
      scale: [...object.transform.scale] as Vec3,
      uniformScale: 1,
      visible: true,
    })),
    ...scene.cameras.map((camera): StudioObject => ({
      id: camera.id,
      name: camera.name,
      kind: "camera",
      color: "#d4b66f",
      position: [...camera.position] as Vec3,
      rotation: getUprightCameraRotation(camera.position, camera.target, [0, 0, 0]),
      scale: [1, 1, 1],
      uniformScale: 1,
      visible: true,
      cameraFov: camera.fov,
      cameraTargetObjectId: null,
      cameraTargetPosition: [...camera.target] as Vec3,
    })),
  ];
  const firstCamera = scene.cameras[0];
  return readDirectorStudioState({
    ...fallback,
    objects,
    camera: firstCamera ? {
      position: [...firstCamera.position] as Vec3,
      fov: firstCamera.fov,
      targetObjectId: null,
      targetPosition: [...firstCamera.target] as Vec3,
    } : fallback.camera,
  });
}
