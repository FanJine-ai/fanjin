import { Scene, Vector3, type Object3D } from "three";
import { getCaptureCrop } from "./capture-crop";
import { DIRECTOR_VIEW_SCALE } from "./director-view-scale";
import type {
  DirectorObject,
  DirectorStudioState,
} from "./types";
import type { DirectorViewPreset } from "./DirectorScenePreview";

export function hideDirectorHelpers(scene: Scene) {
  const hiddenHelpers: Array<{ object: Object3D; visible: boolean }> = [];
  scene.traverse((object) => {
    const gizmoObject = object as Object3D & {
      isTransformControls?: boolean;
      isTransformControlsGizmo?: boolean;
      isTransformControlsPlane?: boolean;
    };
    const isTransformGizmo =
      gizmoObject.isTransformControls === true ||
      gizmoObject.isTransformControlsGizmo === true ||
      gizmoObject.isTransformControlsPlane === true;
    const isPoseMarker = object.userData.poseJointLabel !== undefined;
    if (
      isTransformGizmo ||
      isPoseMarker ||
      object.userData.directorCameraHelper === true ||
      object.userData.directorTransformHelper === true ||
      object.userData.directorPoseRig === true
    ) {
      hiddenHelpers.push({ object, visible: object.visible });
      object.visible = false;
    }
  });
  return hiddenHelpers;
}

export function restoreDirectorHelpers(
  hiddenHelpers: Array<{ object: Object3D; visible: boolean }>,
) {
  hiddenHelpers.forEach(({ object, visible }) => {
    object.visible = visible;
  });
}

export function createCroppedCapture(canvas: HTMLCanvasElement, ratio: string) {
  return new Promise<{
    blob: Blob;
    width: number;
    height: number;
  } | null>((resolve) => {
    const crop = getCaptureCrop(canvas.width, canvas.height, ratio);
    const output = document.createElement("canvas");
    output.width = crop.width;
    output.height = crop.height;
    const context = output.getContext("2d");
    if (!context) {
      resolve(null);
      return;
    }
    context.drawImage(
      canvas,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    output.toBlob(
      (blob) =>
        resolve(
          blob ? { blob, width: output.width, height: output.height } : null,
        ),
      "image/png",
    );
  });
}

export function getCameraObjectAimTarget(
  cameraObject: DirectorObject,
  studio: DirectorStudioState,
): [number, number, number] {
  const targetObjectId =
    cameraObject.cameraTargetObjectId !== undefined
      ? cameraObject.cameraTargetObjectId
      : studio.camera.targetObjectId;
  const targetObject = targetObjectId
    ? studio.objects.find((object) => object.id === targetObjectId)
    : null;

  if (targetObject) {
    return [
      targetObject.position[0],
      targetObject.position[1] + 1,
      targetObject.position[2],
    ];
  }

  return cameraObject.cameraTargetPosition ?? studio.camera.targetPosition;
}

export function getViewPresetOffset(preset: DirectorViewPreset, distance: number) {
  const topDownOffset = new Vector3(
    0,
    Math.cos(DIRECTOR_VIEW_SCALE.initialPolarAngle) * distance,
    Math.sin(DIRECTOR_VIEW_SCALE.initialPolarAngle) * distance,
  );

  switch (preset) {
    case "x-positive":
      return new Vector3(distance, 0, 0);
    case "x-negative":
      return new Vector3(-distance, 0, 0);
    case "y-negative":
      return topDownOffset.negate();
    case "z-positive":
      return new Vector3(0, 0, distance);
    case "z-negative":
      return new Vector3(0, 0, -distance);
    case "y-positive":
    case "reset":
    default:
      return topDownOffset;
  }
}
