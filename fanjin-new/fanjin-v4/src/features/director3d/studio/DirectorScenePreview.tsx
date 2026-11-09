"use client";

import {
  Billboard,
  OrbitControls,
  PerspectiveCamera,
  Line,
  RoundedBox,
  Text,
  TransformControls,
} from "@react-three/drei";
import {
  Canvas,
  createPortal,
  events as createPointerEvents,
  type RootStore,
  type ThreeEvent,
  useFrame,
  useThree,
} from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Euler,
  MOUSE,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera as ThreePerspectiveCamera,
  Quaternion,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type GridHelper,
  type Group,
  type Material,
  type Object3D,
} from "three";
import type {
  OrbitControls as OrbitControlsImpl,
  TransformControls as TransformControlsImpl,
} from "three-stdlib";
import type {
  DirectorCharacterModel,
  DirectorObject,
  DirectorPoseAdjustments,
  DirectorPoseJointRotations,
  DirectorPosePreset,
  DirectorStudioState,
  DirectorTheme,
  DirectorViewMode,
} from "./types";
import {
  clampDirectorPosition,
  DIRECTOR_STAGE,
  getDirectorPoseAdjustments,
  getDirectorCharacterVisualScale,
  getDirectorActiveCamera,
  getDirectorPositionMode,
} from "./types";
import { getCaptureAspectRatio, getCaptureCrop } from "./capture-crop";
import {
  DIRECTOR_VIEW_SCALE,
  getDirectorOverviewDistance,
  getDirectorViewScale,
} from "./director-view-scale";
import { getCameraHelperRotation } from "./camera-orientation";
import {
  getCameraFrustumHalfSize,
  getVerticalFovFromHorizontal,
} from "./camera-projection";
import {
  createCroppedCapture,
  getCameraObjectAimTarget,
  getViewPresetOffset,
  hideDirectorHelpers,
  restoreDirectorHelpers,
} from "./director-scene-helpers";
import {
  applyCharacterPose,
  captureCharacterBindPose,
  CHARACTER_POSE_MARKER_JOINT_IDS,
  CHARACTER_POSE_JOINTS,
  CHARACTER_POSE_LINKS,
  getCharacterBone,
  getCharacterBonePositionInModelSpace,
  getCharacterPoseJointPositions,
  type CharacterPoseJointId,
} from "./character-pose";
import { createProceduralDirectorCharacter } from "./procedural-character";

export interface DirectorSceneCapture {
  capture: () => Promise<{
    blob: Blob;
    width: number;
    height: number;
  } | null>;
  captureCamera: (cameraId: string | null) => Promise<{
    blob: Blob;
    width: number;
    height: number;
  } | null>;
}

export type DirectorViewPreset =
  | "reset"
  | "x-positive"
  | "x-negative"
  | "y-positive"
  | "y-negative"
  | "z-positive"
  | "z-negative";

export type DirectorViewOrientation = [number, number, number, number];

/** Physical editor size of the camera model in scene units (metres). */
const CAMERA_GIZMO_WORLD_SCALE = 0.28;
const CAMERA_GIZMO_LENS_DEPTH = 0.23;
const DIRECTOR_GRID_COLORS: Record<
  DirectorTheme,
  { center: string; grid: string }
> = {
  dark: { center: "#8a8a8a", grid: "#383838" },
  light: { center: "#a9aaae", grid: "#d4d5d8" },
};
/** Light-theme stage background used when the scene keeps its default sky. */
const DIRECTOR_LIGHT_BACKGROUND = "#e1e2e4";

interface DirectorScenePreviewProps {
  studio: DirectorStudioState;
  theme: DirectorTheme;
  viewMode: DirectorViewMode;
  selectedObjectId: string | null;
  poseEditingObjectId: string | null;
  viewCommand: { id: number; preset: DirectorViewPreset } | null;
  focusObjectCommand: { id: number; objectId: string } | null;
  onSelectObject: (objectId: string | null) => void;
  onObjectTransformCommit: (
    objectId: string,
    patch: Partial<
      Pick<
        DirectorObject,
        | "position"
        | "rotation"
        | "scale"
        | "poseJointRotations"
        | "cameraTargetObjectId"
        | "cameraTargetPosition"
      >
    >,
  ) => void;
  onSceneScaleChange: (scale: number) => void;
  onViewOrientationChange: (orientation: DirectorViewOrientation) => void;
  onCaptureReady: (capture: DirectorSceneCapture) => void;
}

/**
 * R3F's default manager assumes its DOM event source still exists after the
 * asynchronous Canvas setup. Radix can transiently reparent dialog content,
 * making that source null in development and causing `connect` to throw.
 */
function createDialogPointerEvents(store: RootStore) {
  const eventManager = createPointerEvents(store);
  const connect = eventManager.connect;

  return {
    ...eventManager,
    connect: (target: HTMLElement | null) => {
      if (target) connect?.(target);
    },
  };
}

export function DirectorScenePreview({
  studio,
  theme,
  viewMode,
  selectedObjectId,
  poseEditingObjectId,
  viewCommand,
  focusObjectCommand,
  onSelectObject,
  onObjectTransformCommit,
  onSceneScaleChange,
  onViewOrientationChange,
  onCaptureReady,
}: DirectorScenePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const activeCameraRef = useRef<ThreePerspectiveCamera | null>(null);
  const orbitControlsRef = useRef<OrbitControlsImpl | null>(null);
  const directorCameraRef = useRef<ThreePerspectiveCamera | null>(null);
  const initialCameraSetupRef = useRef(false);
  const isSyncingScaleFromControlsRef = useRef(false);
  const previousViewModeRef = useRef<DirectorViewMode | null>(null);
  const previousSceneScaleRef = useRef<number | null>(null);
  const previousViewCommandIdRef = useRef<number | null>(null);
  const previousFocusObjectCommandIdRef = useRef<number | null>(null);
  const focusAnimationFrameRef = useRef<number | null>(null);
  const suppressSceneScaleReportingRef = useRef(false);
  const orientationFrameRef = useRef<number | null>(null);
  const pendingOrientationRef = useRef<DirectorViewOrientation | null>(null);
  const studioRef = useRef(studio);

  useEffect(() => {
    studioRef.current = studio;
  }, [studio]);

  const reportViewOrientation = useCallback(() => {
    if (viewMode !== "director") return;
    const camera = directorCameraRef.current;
    if (!camera) return;

    pendingOrientationRef.current =
      camera.quaternion.toArray() as DirectorViewOrientation;
    if (orientationFrameRef.current !== null) return;

    orientationFrameRef.current = window.requestAnimationFrame(() => {
      orientationFrameRef.current = null;
      const orientation = pendingOrientationRef.current;
      if (orientation) onViewOrientationChange(orientation);
    });
  }, [onViewOrientationChange, viewMode]);

  useEffect(
    () => () => {
      if (orientationFrameRef.current !== null) {
        window.cancelAnimationFrame(orientationFrameRef.current);
      }
      if (focusAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(focusAnimationFrameRef.current);
      }
    },
    [],
  );

  const activeCamera = useMemo(
    () => getDirectorActiveCamera(studio, selectedObjectId),
    [selectedObjectId, studio],
  );
  const targetObject = studio.objects.find(
    (object) => object.id === activeCamera.targetObjectId,
  );
  const cameraAimTarget = useMemo(
    () =>
      targetObject
        ? ([
            targetObject.position[0],
            targetObject.position[1] + 1,
            targetObject.position[2],
          ] as [number, number, number])
        : activeCamera.targetPosition,
    [activeCamera.targetPosition, targetObject],
  );
  const target = useMemo(() => {
    const localTarget = new Vector3(...cameraAimTarget);

    return localTarget
      .applyEuler(new Euler(...studio.scene.rotation))
      .add(new Vector3(...studio.scene.position))
      .toArray() as [number, number, number];
  }, [cameraAimTarget, studio.scene]);
  const sceneCenter = useMemo(
    () =>
      new Vector3(...studio.scene.position).toArray() as [
        number,
        number,
        number,
      ],
    [studio.scene.position],
  );
  const viewTarget = viewMode === "director" ? sceneCenter : target;
  const cameraPosition = useMemo(() => {
    const sceneEuler = new Euler(...studio.scene.rotation);

    if (viewMode === "camera") {
      return new Vector3(...activeCamera.position)
        .applyEuler(sceneEuler)
        .add(new Vector3(...studio.scene.position))
        .toArray() as [number, number, number];
    }

    // Keep the low-angle starting view away from the polar singularity, which
    // makes horizontal orbiting flip/roll.
    const distance = getDirectorOverviewDistance(studio.scene.scale);
    return new Vector3(
      0,
      Math.cos(DIRECTOR_VIEW_SCALE.initialPolarAngle) * distance,
      Math.sin(DIRECTOR_VIEW_SCALE.initialPolarAngle) * distance,
    )
      .applyEuler(sceneEuler)
      .add(new Vector3(...sceneCenter))
      .toArray() as [number, number, number];
  }, [activeCamera.position, sceneCenter, studio.scene, viewMode]);
  const captureAspectRatio = getCaptureAspectRatio(studio.captureRatio);
  const cameraFov =
    viewMode === "camera"
      ? getVerticalFovFromHorizontal(activeCamera.fov, captureAspectRatio)
      : 46;
  const initializeDirectorCamera = useCallback(
    (camera: ThreePerspectiveCamera) => {
      if (initialCameraSetupRef.current) return;
      camera.position.fromArray(cameraPosition);
      camera.up.set(0, 1, 0);
      camera.updateProjectionMatrix();
      initialCameraSetupRef.current = true;
    },
    [cameraPosition],
  );

  useEffect(() => {
    onCaptureReady({
      capture: () => {
        const currentStudio = studioRef.current;
        const canvas = canvasRef.current;
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const activeCamera = activeCameraRef.current;
        if (!canvas || !renderer || !scene || !activeCamera) {
          return Promise.resolve(null);
        }

        const hiddenHelpers = hideDirectorHelpers(scene);
        try {
          renderer.render(scene, activeCamera);
          return createCroppedCapture(canvas, currentStudio.captureRatio);
        } finally {
          restoreDirectorHelpers(hiddenHelpers);
          renderer.render(scene, activeCamera);
        }
      },
      captureCamera: (cameraId) => {
        const currentStudio = studioRef.current;
        const canvas = canvasRef.current;
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const activeCamera = activeCameraRef.current;
        const selectedCamera = cameraId
          ? currentStudio.objects.find(
              (object) => object.id === cameraId && object.kind === "camera",
            )
          : null;
        if (
          !canvas ||
          !renderer ||
          !scene ||
          !activeCamera ||
          (cameraId && !selectedCamera)
        ) {
          return Promise.resolve(null);
        }

        const sceneEuler = new Euler(...currentStudio.scene.rotation);
        const localPosition =
          selectedCamera?.position ?? currentStudio.camera.position;
        const cameraPosition = new Vector3(...localPosition)
          .applyEuler(sceneEuler)
          .add(new Vector3(...currentStudio.scene.position));
        const localShotTarget = selectedCamera
          ? getCameraObjectAimTarget(selectedCamera, currentStudio)
          : cameraAimTarget;
        const shotTarget = new Vector3(...localShotTarget)
          .applyEuler(sceneEuler)
          .add(new Vector3(...currentStudio.scene.position));
        // Viewport/scissor coordinates are physical drawing-buffer pixels.
        // `getSize()` returns CSS pixels, which is incorrect when R3F is
        // running at DPR 2 and makes the camera preview render into only a
        // fraction of the canvas.
        const renderSize = renderer.getDrawingBufferSize(new Vector2());
        const captureViewport = getCaptureCrop(
          renderSize.x,
          renderSize.y,
          currentStudio.captureRatio,
        );
        const shotCamera = new ThreePerspectiveCamera(
          getVerticalFovFromHorizontal(
            selectedCamera?.cameraFov ?? currentStudio.camera.fov,
            captureAspectRatio,
          ),
          captureAspectRatio,
          0.1,
          200,
        );
        shotCamera.position.copy(cameraPosition);
        // The saved look-at target is the single source of truth for both a
        // selected scene camera and the current camera. This keeps the visible
        // frustum centre line and the rendered shot on the exact same axis.
        shotCamera.up.set(0, 1, 0).applyEuler(sceneEuler).normalize();
        shotCamera.lookAt(shotTarget);
        shotCamera.updateProjectionMatrix();
        shotCamera.updateMatrixWorld(true);
        scene.updateMatrixWorld(true);

        // A scene camera is modelled around the exact origin used by the
        // temporary render camera. Hide all camera helpers for this render so
        // the selected camera cannot photograph the inside of its own body or
        // its frustum lines. Restore them immediately for the director view.
        const hiddenCameraHelpers = hideDirectorHelpers(scene);

        try {
          // Render the shot through the exact selected output aspect ratio.
          // The helper frustum uses this same ratio, so its four corner rays
          // now describe the image that will actually appear in the preview.
          const viewportY =
            renderSize.y - captureViewport.y - captureViewport.height;
          renderer.setViewport(
            captureViewport.x,
            viewportY,
            captureViewport.width,
            captureViewport.height,
          );
          renderer.setScissor(
            captureViewport.x,
            viewportY,
            captureViewport.width,
            captureViewport.height,
          );
          renderer.setScissorTest(true);
          renderer.render(scene, shotCamera);
          return createCroppedCapture(canvas, currentStudio.captureRatio);
        } finally {
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, renderSize.x, renderSize.y);
          restoreDirectorHelpers(hiddenCameraHelpers);
          renderer.render(scene, activeCamera);
        }
      },
    });
  }, [cameraAimTarget, captureAspectRatio, onCaptureReady]);

  useLayoutEffect(() => {
    const camera = directorCameraRef.current;
    const controls = orbitControlsRef.current;
    if (!camera || !controls) return;

    const isEnteringView = previousViewModeRef.current !== viewMode;
    const scaleChanged =
      previousSceneScaleRef.current !== null &&
      previousSceneScaleRef.current !== studio.scene.scale;
    const isSyncingScaleFromControls = isSyncingScaleFromControlsRef.current;
    isSyncingScaleFromControlsRef.current = false;

    if (isEnteringView) {
      camera.position.fromArray(cameraPosition);
      camera.up.set(0, 1, 0);
      controls.target.fromArray(viewTarget);
      controls.update();
      reportViewOrientation();
    } else if (
      viewMode === "director" &&
      scaleChanged &&
      !isSyncingScaleFromControls
    ) {
      // Slider and numeric input preserve the current orbit direction; only
      // their distance changes. Wheel updates already moved the camera itself.
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 0.0001) offset.set(0, 1, 0);
      offset.setLength(getDirectorOverviewDistance(studio.scene.scale));
      camera.position.copy(controls.target).add(offset);
      controls.update();
      reportViewOrientation();
    }

    previousViewModeRef.current = viewMode;
    previousSceneScaleRef.current = studio.scene.scale;
  }, [
    cameraPosition,
    reportViewOrientation,
    studio.scene.scale,
    viewMode,
    viewTarget,
  ]);

  useLayoutEffect(() => {
    const camera = directorCameraRef.current;
    const controls = orbitControlsRef.current;
    if (
      !camera ||
      !controls ||
      !viewCommand ||
      previousViewCommandIdRef.current === viewCommand.id
    ) {
      return;
    }

    const distance = getDirectorOverviewDistance(studio.scene.scale);
    const offset = getViewPresetOffset(viewCommand.preset, distance);
    camera.up.set(0, 1, 0);
    controls.target.fromArray(sceneCenter);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    reportViewOrientation();
    previousViewCommandIdRef.current = viewCommand.id;
  }, [reportViewOrientation, sceneCenter, studio.scene.scale, viewCommand]);

  useLayoutEffect(() => {
    const camera = directorCameraRef.current;
    const controls = orbitControlsRef.current;
    if (
      viewMode !== "director" ||
      !camera ||
      !controls ||
      !focusObjectCommand ||
      previousFocusObjectCommandIdRef.current === focusObjectCommand.id
    ) {
      return;
    }

    previousFocusObjectCommandIdRef.current = focusObjectCommand.id;
    const object = studio.objects.find(
      (entry) => entry.id === focusObjectCommand.objectId,
    );
    if (!object || object.kind !== "character") return;

    if (focusAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationFrameRef.current);
    }

    const heightScale = Math.abs(
      object.scale[1] *
        (object.uniformScale ?? 1) *
        (object.kind === "character"
          ? getDirectorCharacterVisualScale(object.characterModel)
          : 1),
    );
    const finalTarget = new Vector3(
      object.position[0],
      object.position[1] + 0.95 * heightScale,
      object.position[2],
    )
      .applyEuler(new Euler(...studio.scene.rotation))
      .add(new Vector3(...studio.scene.position));
    const startTarget = controls.target.clone();
    const startPosition = camera.position.clone();
    const viewDirection = startPosition.clone().sub(startTarget);
    if (viewDirection.lengthSq() < 0.0001) viewDirection.set(0, 0.35, 1);
    viewDirection.normalize();
    const finalPosition = finalTarget
      .clone()
      .add(
        viewDirection.multiplyScalar(
          getDirectorOverviewDistance(DIRECTOR_VIEW_SCALE.maxScale),
        ),
      );
    const startedAt = performance.now();
    const duration = 320;
    const wasEnabled = controls.enabled;

    suppressSceneScaleReportingRef.current = true;
    controls.enabled = false;

    const animateFocus = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      controls.target.lerpVectors(startTarget, finalTarget, eased);
      camera.position.lerpVectors(startPosition, finalPosition, eased);
      controls.update();
      reportViewOrientation();

      if (progress < 1) {
        focusAnimationFrameRef.current =
          window.requestAnimationFrame(animateFocus);
        return;
      }

      focusAnimationFrameRef.current = null;
      controls.enabled = wasEnabled;
      suppressSceneScaleReportingRef.current = false;
      isSyncingScaleFromControlsRef.current = true;
      onSceneScaleChange(DIRECTOR_VIEW_SCALE.maxScale);
    };

    focusAnimationFrameRef.current = window.requestAnimationFrame(animateFocus);

    return () => {
      if (focusAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(focusAnimationFrameRef.current);
        focusAnimationFrameRef.current = null;
      }
      controls.enabled = wasEnabled;
      suppressSceneScaleReportingRef.current = false;
    };
  }, [
    focusObjectCommand,
    onSceneScaleChange,
    reportViewOrientation,
    studio.objects,
    studio.scene.position,
    studio.scene.rotation,
    viewMode,
  ]);

  const stageBackground =
    theme === "light" && studio.scene.skyColor === "#1d1d1d"
      ? DIRECTOR_LIGHT_BACKGROUND
      : studio.scene.skyColor;
  const gridColors = DIRECTOR_GRID_COLORS[theme];

  return (
    <Canvas
      dpr={[1, 2]}
      events={createDialogPointerEvents}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={(state) => {
        canvasRef.current = state.gl.domElement;
        rendererRef.current = state.gl;
        sceneRef.current = state.scene;
        activeCameraRef.current = state.camera as ThreePerspectiveCamera;
      }}
      onPointerMissed={() => onSelectObject(null)}
      className="h-full w-full"
    >
      <color attach="background" args={[stageBackground]} />
      <fog attach="fog" args={[stageBackground, 72, 180]} />
      <ambientLight intensity={0.72} />
      <directionalLight position={[5, 7, 4]} intensity={1.5} castShadow />
      <pointLight position={[-5, 3, -2]} intensity={0.6} color="#8ba5c9" />
      <PerspectiveCamera
        ref={directorCameraRef}
        makeDefault
        fov={cameraFov}
        onUpdate={initializeDirectorCamera}
      />
      <OrbitControls
        ref={orbitControlsRef}
        enabled={viewMode === "director"}
        enableDamping
        dampingFactor={0.12}
        minPolarAngle={0.01}
        maxPolarAngle={Math.PI - 0.01}
        minDistance={getDirectorOverviewDistance(
          poseEditingObjectId
            ? DIRECTOR_VIEW_SCALE.poseMaxScale
            : DIRECTOR_VIEW_SCALE.maxScale,
        )}
        maxDistance={getDirectorOverviewDistance(DIRECTOR_VIEW_SCALE.minScale)}
        zoomSpeed={0.78}
        mouseButtons={{
          LEFT: MOUSE.ROTATE,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.PAN,
        }}
        target={viewTarget}
        onChange={() => {
          reportViewOrientation();
          if (viewMode !== "director") return;
          if (suppressSceneScaleReportingRef.current) return;
          const controls = orbitControlsRef.current;
          if (!controls) return;
          const nextScale = getDirectorViewScale(
            controls.object.position.distanceTo(controls.target),
          );
          if (Math.abs(nextScale - studio.scene.scale) >= 0.02) {
            isSyncingScaleFromControlsRef.current = true;
            onSceneScaleChange(Number(nextScale.toFixed(2)));
          }
        }}
        onEnd={() => {
          if (viewMode !== "director") return;
          if (suppressSceneScaleReportingRef.current) return;
          const controls = orbitControlsRef.current;
          if (!controls) return;
          const nextScale = getDirectorViewScale(
            controls.object.position.distanceTo(controls.target),
          );
          if (Math.abs(nextScale - studio.scene.scale) >= 0.005) {
            isSyncingScaleFromControlsRef.current = true;
            onSceneScaleChange(Number(nextScale.toFixed(2)));
          }
        }}
      />
      <group position={studio.scene.position} rotation={studio.scene.rotation}>
        <SceneGrid
          visible={studio.scene.groundVisible}
          opacity={studio.scene.groundOpacity}
          centerColor={gridColors.center}
          gridColor={gridColors.grid}
        />
        {studio.objects
          .filter(
            (object) =>
              object.visible &&
              (viewMode === "director" || object.kind !== "camera"),
          )
          .map((object) => (
            <TransformableDirectorObject
              key={object.id}
              object={object}
              selected={object.id === selectedObjectId}
              showPoseRig={
                viewMode === "director" && object.id === poseEditingObjectId
              }
              transformEnabled={
                viewMode === "director" &&
                object.id === selectedObjectId &&
                object.id !== poseEditingObjectId
              }
              snapToGrid={studio.scene.snapToGrid}
              showLabel={
                studio.scene.showCharacterLabels &&
                (object.kind === "character" || object.kind === "crowd")
              }
              cameraTarget={
                object.kind === "camera"
                  ? getCameraObjectAimTarget(object, studio)
                  : cameraAimTarget
              }
              cameraAspectRatio={captureAspectRatio}
              orbitControlsRef={orbitControlsRef}
              onSelect={onSelectObject}
              onTransformCommit={onObjectTransformCommit}
            />
          ))}
      </group>
    </Canvas>
  );
}

function TransformableDirectorObject({
  object,
  selected,
  showPoseRig,
  transformEnabled,
  snapToGrid,
  showLabel,
  cameraTarget,
  cameraAspectRatio,
  orbitControlsRef,
  onSelect,
  onTransformCommit,
}: {
  object: DirectorObject;
  selected: boolean;
  showPoseRig: boolean;
  transformEnabled: boolean;
  snapToGrid: boolean;
  showLabel: boolean;
  cameraTarget: [number, number, number];
  cameraAspectRatio: number;
  orbitControlsRef: RefObject<OrbitControlsImpl | null>;
  onSelect: (objectId: string) => void;
  onTransformCommit: (
    objectId: string,
    patch: Partial<
      Pick<
        DirectorObject,
        | "position"
        | "rotation"
        | "scale"
        | "poseJointRotations"
        | "cameraTargetObjectId"
        | "cameraTargetPosition"
      >
    >,
  ) => void;
}) {
  const pivotRef = useRef<Group>(null!);
  const selectionRingRef = useRef<Group>(null);
  const translateControlsRef = useRef<TransformControlsImpl | null>(null);
  const effectiveScale = useMemo(
    () =>
      object.scale.map(
        (value) =>
          value *
          (object.uniformScale ?? 1) *
          (object.kind === "character"
            ? getDirectorCharacterVisualScale(object.characterModel)
            : 1),
      ) as [number, number, number],
    [object.characterModel, object.kind, object.scale, object.uniformScale],
  );
  const showSelectionRing =
    selected &&
    (object.kind === "character" ||
      object.kind === "crowd" ||
      object.kind === "camera");
  const localObject = useMemo(
    () => ({
      ...object,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      uniformScale: 1,
    }),
    [object],
  );
  const localCameraTarget = useMemo(
    () =>
      object.kind === "camera"
        ? ([
            cameraTarget[0] - object.position[0],
            cameraTarget[1] - object.position[1],
            cameraTarget[2] - object.position[2],
          ] as [number, number, number])
        : cameraTarget,
    [cameraTarget, object.kind, object.position],
  );

  const constrainPivotPosition = useCallback(() => {
    const pivot = pivotRef.current;
    let nextPosition = pivot.position.toArray() as [number, number, number];
    if (snapToGrid) {
      nextPosition = nextPosition.map((value) => Math.round(value * 2) / 2) as [
        number,
        number,
        number,
      ];
    }
    nextPosition = clampDirectorPosition(
      nextPosition,
      getDirectorPositionMode(object.kind),
    );
    pivot.position.fromArray(nextPosition);
    selectionRingRef.current?.position.set(nextPosition[0], 0, nextPosition[2]);
    return nextPosition;
  }, [object.kind, snapToGrid]);

  const disableOrbit = () => {
    if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;
  };
  const enableOrbit = () => {
    if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
  };

  const commitTranslation = () => {
    enableOrbit();
    onTransformCommit(object.id, {
      position: constrainPivotPosition(),
    });
  };

  useEffect(
    () => () => {
      if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
    },
    [orbitControlsRef],
  );

  useEffect(() => {
    const controls = translateControlsRef.current;
    if (controls) controls.userData.directorTransformHelper = true;
  }, [transformEnabled]);

  const objectVisual = (
    <DirectorObjectMesh
      object={localObject}
      selected={selected}
      showPoseRig={showPoseRig}
      showLabel={showLabel}
      cameraTarget={localCameraTarget}
      cameraAspectRatio={cameraAspectRatio}
      orbitControlsRef={orbitControlsRef}
      onSelect={onSelect}
      onPoseJointRotationsChange={(poseJointRotations) =>
        onTransformCommit(object.id, { poseJointRotations })
      }
    />
  );

  if (!transformEnabled) {
    return (
      <>
        <group
          position={object.position}
          rotation={object.kind === "camera" ? [0, 0, 0] : object.rotation}
          scale={object.kind === "camera" ? [1, 1, 1] : effectiveScale}
        >
          {objectVisual}
        </group>
        {showSelectionRing && (
          <group position={[object.position[0], 0, object.position[2]]}>
            <SelectionBaseRing kind={object.kind} scale={effectiveScale} />
          </group>
        )}
      </>
    );
  }

  return (
    <>
      <group
        ref={pivotRef}
        position={object.position}
        rotation={object.kind === "camera" ? [0, 0, 0] : object.rotation}
        scale={object.kind === "camera" ? [1, 1, 1] : effectiveScale}
      >
        {objectVisual}
      </group>
      {showSelectionRing && (
        <group
          ref={selectionRingRef}
          position={[object.position[0], 0, object.position[2]]}
        >
          <SelectionBaseRing kind={object.kind} scale={effectiveScale} />
        </group>
      )}
      <TransformControls
        ref={translateControlsRef}
        object={pivotRef}
        mode="translate"
        space="world"
        size={0.78}
        translationSnap={snapToGrid ? 0.5 : undefined}
        onMouseDown={disableOrbit}
        onObjectChange={constrainPivotPosition}
        onMouseUp={commitTranslation}
      />
    </>
  );
}

function SelectionBaseRing({
  kind,
  scale,
}: {
  kind: DirectorObject["kind"];
  scale: [number, number, number];
}) {
  const radius =
    (kind === "camera" ? 0.42 : 0.56) *
    Math.max(Math.abs(scale[0]), Math.abs(scale[2]));
  const y = 0.025;
  const points = useMemo(
    () =>
      Array.from({ length: 49 }, (_, index) => {
        const angle = (index / 48) * Math.PI * 2;
        return [Math.cos(angle) * radius, y, Math.sin(angle) * radius] as [
          number,
          number,
          number,
        ];
      }),
    [radius, y],
  );

  return (
    <group userData={{ directorTransformHelper: true }}>
      <Line
        points={points}
        color="#4f8cff"
        lineWidth={2.4}
        transparent
        opacity={0.94}
      />
    </group>
  );
}

function SceneGrid({
  visible,
  opacity,
  centerColor,
  gridColor,
}: {
  visible: boolean;
  opacity: number;
  centerColor: string;
  gridColor: string;
}) {
  const gridRef = useRef<GridHelper | null>(null);

  useEffect(() => {
    const material = gridRef.current?.material;
    const materials = Array.isArray(material) ? material : [material];
    materials.filter(Boolean).forEach((entry) => {
      const gridMaterial = entry as Material;
      gridMaterial.transparent = opacity < 1;
      gridMaterial.opacity = opacity;
      gridMaterial.needsUpdate = true;
    });
  }, [opacity]);

  if (!visible) return null;

  return (
    <gridHelper
      ref={gridRef}
      args={[DIRECTOR_STAGE.size, DIRECTOR_STAGE.size, centerColor, gridColor]}
      position={[0, 0, 0]}
    />
  );
}

function DirectorObjectMesh({
  object,
  selected,
  showPoseRig,
  showLabel,
  cameraTarget,
  cameraAspectRatio,
  orbitControlsRef,
  onSelect,
  onPoseJointRotationsChange,
}: {
  object: DirectorObject;
  selected: boolean;
  showPoseRig: boolean;
  showLabel: boolean;
  cameraTarget: [number, number, number];
  cameraAspectRatio: number;
  orbitControlsRef: RefObject<OrbitControlsImpl | null>;
  onSelect: (objectId: string) => void;
  onPoseJointRotationsChange: (
    poseJointRotations: NonNullable<DirectorObject["poseJointRotations"]>,
  ) => void;
}) {
  const material = useMemo(
    () => ({
      color: object.color,
      emissive: selected ? "#777777" : "#000000",
      emissiveIntensity: selected ? 0.28 : 0,
    }),
    [object.color, selected],
  );
  const renderScale = useMemo(
    () =>
      object.scale.map((value) => value * (object.uniformScale ?? 1)) as [
        number,
        number,
        number,
      ],
    [object.scale, object.uniformScale],
  );
  const handleClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    onSelect(object.id);
  };

  if (object.kind === "character") {
    const characterModel = object.characterModel ?? "adult-male";
    return (
      <group
        position={object.position}
        rotation={object.rotation}
        scale={renderScale}
        onClick={handleClick}
      >
        <ProceduralCharacter
          characterModel={characterModel}
          color={object.color}
          selected={selected}
          showPoseRig={showPoseRig}
          posePreset={object.posePreset ?? "standing"}
          poseAdjustments={getDirectorPoseAdjustments(
            object.posePreset ?? "standing",
            object.poseAdjustments,
          )}
          poseJointRotations={object.poseJointRotations ?? {}}
          name={object.name}
          showLabel={showLabel}
          characterVisualScale={getDirectorCharacterVisualScale(characterModel)}
          orbitControlsRef={orbitControlsRef}
          onPoseJointRotationsChange={onPoseJointRotationsChange}
        />
      </group>
    );
  }

  if (object.kind === "camera") {
    return (
      <DirectorCameraMesh
        object={object}
        selected={selected}
        target={cameraTarget}
        aspectRatio={cameraAspectRatio}
        onClick={handleClick}
      />
    );
  }

  if (object.kind === "sphere") {
    return (
      <mesh
        position={[
          object.position[0],
          object.position[1] + 0.72,
          object.position[2],
        ]}
        rotation={object.rotation}
        scale={renderScale}
        castShadow
        onClick={handleClick}
      >
        <sphereGeometry args={[0.72, 28, 28]} />
        <meshStandardMaterial {...material} roughness={0.62} metalness={0.04} />
      </mesh>
    );
  }

  if (object.kind === "crowd") {
    return (
      <group
        position={object.position}
        rotation={object.rotation}
        scale={renderScale}
        onClick={handleClick}
      >
        {[-0.55, 0, 0.55].map((offset) => (
          <group key={offset} position={[offset, 0, Math.abs(offset) * 0.36]}>
            <mesh position={[0, 1.3, 0]} castShadow>
              <sphereGeometry args={[0.18, 16, 16]} />
              <meshStandardMaterial {...material} roughness={0.84} />
            </mesh>
            <mesh position={[0, 0.65, 0]} castShadow>
              <capsuleGeometry args={[0.2, 0.72, 6, 12]} />
              <meshStandardMaterial {...material} roughness={0.84} />
            </mesh>
          </group>
        ))}
        {showLabel && (
          <CharacterLabel name={object.name} position={[0, 1.58, 0]} />
        )}
      </group>
    );
  }

  return (
    <mesh
      position={[
        object.position[0],
        object.position[1] + 0.55,
        object.position[2],
      ]}
      rotation={object.rotation}
      scale={renderScale}
      castShadow
      onClick={handleClick}
    >
      <boxGeometry args={[1.1, 1.1, 1.1]} />
      <meshStandardMaterial {...material} roughness={0.56} metalness={0.08} />
    </mesh>
  );
}

function ProceduralCharacter({
  characterModel,
  color,
  selected,
  showPoseRig,
  posePreset,
  poseAdjustments,
  poseJointRotations,
  name,
  showLabel,
  characterVisualScale,
  orbitControlsRef,
  onPoseJointRotationsChange,
}: {
  characterModel: DirectorCharacterModel;
  color: string;
  selected: boolean;
  showPoseRig: boolean;
  posePreset: DirectorPosePreset;
  poseAdjustments: DirectorPoseAdjustments;
  poseJointRotations: DirectorPoseJointRotations;
  name: string;
  showLabel: boolean;
  characterVisualScale: number;
  orbitControlsRef: RefObject<OrbitControlsImpl | null>;
  onPoseJointRotationsChange: (
    poseJointRotations: DirectorPoseJointRotations,
  ) => void;
}) {
  const { model, bindPose, bindFootHeights } = useMemo(() => {
    const proceduralModel = createProceduralDirectorCharacter(characterModel);
    const bindFootHeights = {
      left:
        getCharacterBonePositionInModelSpace(proceduralModel, "L_Foot")?.y ?? 0,
      right:
        getCharacterBonePositionInModelSpace(proceduralModel, "R_Foot")?.y ?? 0,
    };
    return {
      model: proceduralModel,
      bindPose: captureCharacterBindPose(proceduralModel),
      bindFootHeights,
    };
  }, [characterModel]);
  const { poseJointPositions, poseGroundOffset } = useMemo(() => {
    applyCharacterPose(
      model,
      bindPose,
      posePreset,
      poseAdjustments,
      poseJointRotations,
    );
    const walkingContactFoot =
      poseAdjustments.rightHipForward >= poseAdjustments.leftHipForward
        ? "R_Foot"
        : "L_Foot";
    const walkingBindHeight =
      walkingContactFoot === "R_Foot"
        ? bindFootHeights.right
        : bindFootHeights.left;
    const walkingCurrentHeight =
      getCharacterBonePositionInModelSpace(model, walkingContactFoot)?.y ??
      walkingBindHeight;
    const leftFootHeight =
      getCharacterBonePositionInModelSpace(model, "L_Foot")?.y ??
      bindFootHeights.left;
    const rightFootHeight =
      getCharacterBonePositionInModelSpace(model, "R_Foot")?.y ??
      bindFootHeights.right;
    const groundedPoseOffset = -Math.min(
      leftFootHeight - bindFootHeights.left,
      rightFootHeight - bindFootHeights.right,
    );
    return {
      poseJointPositions: showPoseRig
        ? getCharacterPoseJointPositions(model)
        : {},
      poseGroundOffset:
        posePreset === "walking"
          ? walkingBindHeight - walkingCurrentHeight
          : posePreset !== "standing" && posePreset !== "t-pose"
            ? groundedPoseOffset
            : 0,
    };
  }, [
    bindPose,
    bindFootHeights,
    model,
    poseAdjustments,
    poseJointRotations,
    posePreset,
    showPoseRig,
  ]);

  useEffect(() => {
    model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((entry) => {
        if (!(entry instanceof MeshStandardMaterial)) return;
        entry.color.set(color);
        if (entry.name === "Director_Suit_Undersuit") {
          entry.color.multiplyScalar(0.64);
        } else if (entry.name === "Director_Joint_Seam") {
          entry.color.multiplyScalar(0.34);
        } else if (entry.name === "Director_Armor_Secondary") {
          entry.color.multiplyScalar(0.84);
        }
        entry.emissive.set(selected ? "#777777" : "#000000");
        entry.emissiveIntensity = selected ? 0.2 : 0;
        entry.needsUpdate = true;
      });
    });
  }, [color, model, selected]);

  useEffect(
    () => () => {
      model.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((entry) => entry.dispose());
        child.geometry.dispose();
      });
    },
    [model],
  );

  return (
    <group position={[0, poseGroundOffset, 0]}>
      <primitive object={model} />
      {showPoseRig && (
        <CharacterPoseRig
          model={model}
          positions={poseJointPositions}
          jointRotations={poseJointRotations}
          orbitControlsRef={orbitControlsRef}
          onJointRotationsChange={onPoseJointRotationsChange}
        />
      )}
      {showLabel && (
        <CharacterLabel
          name={name}
          model={model}
          scale={1 / characterVisualScale}
        />
      )}
    </group>
  );
}

function CharacterPoseRig({
  model,
  positions,
  jointRotations,
  orbitControlsRef,
  onJointRotationsChange,
}: {
  model: Object3D;
  positions: Partial<Record<CharacterPoseJointId, Vector3>>;
  jointRotations: DirectorPoseJointRotations;
  orbitControlsRef: RefObject<OrbitControlsImpl | null>;
  onJointRotationsChange: (
    jointRotations: DirectorPoseJointRotations,
  ) => void;
}) {
  const [activeJointId, setActiveJointId] =
    useState<CharacterPoseJointId | null>(null);
  const [poseRevision, setPoseRevision] = useState(0);
  const scene = useThree((state) => state.scene);
  const rotationProxyRef = useRef<Group>(null!);
  const rotationControlsRef = useRef<TransformControlsImpl | null>(null);
  const rotationDragRef = useRef<{
    jointId: CharacterPoseJointId;
    bone: Object3D;
    boneStartLocal: Quaternion;
    storedRotation: Quaternion;
    proxyStartWorld: Quaternion;
    boneParentWorld: Quaternion;
  } | null>(null);
  const livePositions = useMemo(
    () =>
      poseRevision === 0
        ? positions
        : getCharacterPoseJointPositions(model),
    [model, poseRevision, positions],
  );
  const activeJoint = activeJointId
    ? CHARACTER_POSE_JOINTS.find(({ id }) => id === activeJointId)
    : null;
  const activeBone = activeJoint
    ? getCharacterBone(model, activeJoint.boneName)
    : null;
  const activePosition = activeJointId ? livePositions[activeJointId] : null;

  const enableOrbit = useCallback(() => {
    if (orbitControlsRef.current) orbitControlsRef.current.enabled = true;
  }, [orbitControlsRef]);

  const beginJointRotation = useCallback(() => {
    if (!activeJointId || !activeBone || !rotationProxyRef.current) return;
    if (orbitControlsRef.current) orbitControlsRef.current.enabled = false;

    model.updateMatrixWorld(true);
    rotationProxyRef.current.updateMatrixWorld(true);
    const storedValue = jointRotations[activeJointId] ?? [0, 0, 0, 1];
    rotationDragRef.current = {
      jointId: activeJointId,
      bone: activeBone,
      boneStartLocal: activeBone.quaternion.clone(),
      storedRotation: new Quaternion(...storedValue).normalize(),
      proxyStartWorld: rotationProxyRef.current.getWorldQuaternion(
        new Quaternion(),
      ),
      boneParentWorld: activeBone.parent?.getWorldQuaternion(new Quaternion()) ??
        new Quaternion(),
    };
  }, [activeBone, activeJointId, jointRotations, model, orbitControlsRef]);

  const updateJointRotation = useCallback(() => {
    const drag = rotationDragRef.current;
    const proxy = rotationProxyRef.current;
    if (!drag || !proxy) return;

    proxy.updateMatrixWorld(true);
    const proxyWorld = proxy.getWorldQuaternion(new Quaternion());
    const deltaWorld = proxyWorld.multiply(
      drag.proxyStartWorld.clone().invert(),
    );
    const deltaLocal = drag.boneParentWorld
      .clone()
      .invert()
      .multiply(deltaWorld)
      .multiply(drag.boneParentWorld);

    drag.bone.quaternion
      .copy(deltaLocal.multiply(drag.boneStartLocal))
      .normalize();
    model.updateMatrixWorld(true);
    setPoseRevision((current) => current + 1);
  }, [model]);

  const commitJointRotation = useCallback(() => {
    const drag = rotationDragRef.current;
    if (!drag) {
      enableOrbit();
      return;
    }

    const nextRotation = drag.storedRotation
      .clone()
      .multiply(drag.boneStartLocal.clone().invert())
      .multiply(drag.bone.quaternion)
      .normalize();
    const value = nextRotation
      .toArray()
      .map((entry) => Number(entry.toFixed(6))) as [
      number,
      number,
      number,
      number,
    ];

    onJointRotationsChange({
      ...jointRotations,
      [drag.jointId]: value,
    });
    rotationDragRef.current = null;
    rotationProxyRef.current?.quaternion.identity();
    rotationProxyRef.current?.updateMatrixWorld(true);
    enableOrbit();
  }, [enableOrbit, jointRotations, onJointRotationsChange]);

  useLayoutEffect(() => {
    const proxy = rotationProxyRef.current;
    const position = activeJointId ? positions[activeJointId] : null;
    if (!proxy || !position) return;
    proxy.position.copy(position);
    proxy.quaternion.identity();
    proxy.updateMatrixWorld(true);
  }, [activeJointId, positions]);

  useEffect(() => {
    const controls = rotationControlsRef.current;
    if (controls) controls.userData.directorPoseRig = true;
  }, [activeJointId]);

  useEffect(
    () => () => {
      enableOrbit();
    },
    [enableOrbit],
  );

  return (
    <group userData={{ directorPoseRig: true }} renderOrder={1000}>
      {CHARACTER_POSE_LINKS.map(([fromId, toId]) => {
        const from = livePositions[fromId];
        const to = livePositions[toId];
        if (!from || !to) return null;
        return (
          <Line
            key={`${fromId}-${toId}`}
            points={[from, to]}
            color="#20d9e7"
            lineWidth={1.15}
            depthTest={false}
            transparent
            opacity={0.92}
          />
        );
      })}
      {CHARACTER_POSE_JOINTS.filter(({ id }) =>
        CHARACTER_POSE_MARKER_JOINT_IDS.has(id),
      ).map(({ id, label }) => {
        const position = livePositions[id];
        if (!position) return null;
        const active = activeJointId === id;
        return (
          <CharacterPoseJointMarker
            key={id}
            position={position}
            label={label}
            active={active}
            onPointerDown={(event) => {
              event.stopPropagation();
              setActiveJointId(id);
            }}
          />
        );
      })}
      {activeBone && activePosition && (
        <>
          <group ref={rotationProxyRef} position={activePosition} />
          {createPortal(
            <TransformControls
              ref={rotationControlsRef}
              object={rotationProxyRef}
              mode="rotate"
              space="world"
              size={0.78}
              onMouseDown={beginJointRotation}
              onObjectChange={updateJointRotation}
              onMouseUp={commitJointRotation}
            />,
            scene,
          )}
        </>
      )}
    </group>
  );
}

function CharacterPoseJointMarker({
  position,
  label,
  active,
  onPointerDown,
}: {
  position: Vector3;
  label: string;
  active: boolean;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const markerRef = useRef<Mesh | null>(null);
  const worldPosition = useMemo(() => new Vector3(), []);
  const cameraPosition = useMemo(() => new Vector3(), []);
  const parentWorldScale = useMemo(() => new Vector3(), []);

  useFrame(({ camera, size }) => {
    const marker = markerRef.current;
    if (!marker || !(camera instanceof ThreePerspectiveCamera)) return;

    marker.getWorldPosition(worldPosition);
    camera.getWorldPosition(cameraPosition);
    marker.parent?.getWorldScale(parentWorldScale);

    const distance = Math.max(cameraPosition.distanceTo(worldPosition), 0.001);
    const effectiveFov = camera.getEffectiveFOV() * (Math.PI / 180);
    const worldPerPixel =
      (2 * Math.tan(effectiveFov / 2) * distance) / Math.max(size.height, 1);
    const worldRadius = worldPerPixel * (active ? 10.5 : 9);

    marker.scale.set(
      worldRadius / Math.max(Math.abs(parentWorldScale.x), 0.001),
      worldRadius / Math.max(Math.abs(parentWorldScale.y), 0.001),
      worldRadius / Math.max(Math.abs(parentWorldScale.z), 0.001),
    );
  });

  return (
    <mesh
      ref={markerRef}
      position={position}
      userData={{ poseJointLabel: label }}
      onPointerDown={onPointerDown}
      renderOrder={1001}
    >
      <sphereGeometry args={[1, 18, 18]} />
      <meshBasicMaterial
        color={active ? "#ffffff" : "#25e4ef"}
        depthTest={false}
        transparent
        opacity={0.98}
      />
    </mesh>
  );
}

function DirectorCameraMesh({
  object,
  selected,
  target,
  aspectRatio,
  onClick,
}: {
  object: DirectorObject;
  selected: boolean;
  target: [number, number, number];
  aspectRatio: number;
  onClick: (event: { stopPropagation: () => void }) => void;
}) {
  const cameraBodyMaterial = {
    color: selected ? "#4a5565" : "#30343b",
    emissive: selected ? "#6b7280" : "#000000",
    emissiveIntensity: selected ? 0.3 : 0,
    roughness: 0.3,
    metalness: 0.68,
  };
  const cameraMetalMaterial = {
    color: "#101318",
    roughness: 0.24,
    metalness: 0.82,
  };
  const helperRotation = useMemo(
    () => getCameraHelperRotation(object.position, target),
    [object.position, target],
  );
  // Match LibTV's compact camera gizmo: this guide is intentionally shorter
  // and visually narrower than the real projection. The centre axis still
  // points at the exact shot target; the actual capture keeps the full FOV.
  const frustumDepth = 2;

  return (
    <group
      position={object.position}
      rotation={helperRotation}
      userData={{ directorCameraHelper: true }}
      onClick={onClick}
    >
      <group scale={CAMERA_GIZMO_WORLD_SCALE}>
        <RoundedBox
          args={[1.02, 0.62, 0.68]}
          radius={0.08}
          smoothness={4}
          castShadow
        >
          <meshStandardMaterial {...cameraBodyMaterial} />
        </RoundedBox>
        <RoundedBox
          args={[0.38, 0.22, 0.42]}
          radius={0.04}
          smoothness={3}
          position={[-0.2, 0.43, -0.08]}
          castShadow
        >
          <meshStandardMaterial {...cameraMetalMaterial} />
        </RoundedBox>
        <RoundedBox
          args={[0.54, 0.34, 0.05]}
          radius={0.02}
          smoothness={2}
          position={[0, 0.02, -0.37]}
          castShadow
        >
          <meshStandardMaterial
            color="#111827"
            roughness={0.22}
            metalness={0.48}
          />
        </RoundedBox>
        <mesh position={[0, 0.02, -0.405]} castShadow>
          <planeGeometry args={[0.42, 0.23]} />
          <meshStandardMaterial
            color="#243a52"
            emissive="#1d4d72"
            emissiveIntensity={selected ? 0.9 : 0.38}
            roughness={0.18}
            metalness={0.25}
          />
        </mesh>
        <mesh position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.29, 0.25, 0.42, 28]} />
          <meshStandardMaterial {...cameraMetalMaterial} />
        </mesh>
        <mesh
          position={[0, 0, 0.775]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[0.214, 0.214, 0.024, 28]} />
          <meshPhysicalMaterial
            color="#152b44"
            emissive="#1f79b8"
            emissiveIntensity={selected ? 0.72 : 0.3}
            roughness={0.08}
            metalness={0.45}
            clearcoat={0.85}
          />
        </mesh>
        <mesh position={[0.32, 0.35, 0.04]} castShadow>
          <sphereGeometry args={[0.055, 16, 16]} />
          <meshStandardMaterial
            color="#ef4444"
            emissive="#dc2626"
            emissiveIntensity={selected ? 1.1 : 0.5}
            roughness={0.24}
          />
        </mesh>
        <mesh position={[0, -0.55, 0]} castShadow>
          <cylinderGeometry args={[0.08, 0.1, 0.5, 16]} />
          <meshStandardMaterial {...cameraMetalMaterial} />
        </mesh>
        {[
          [-0.34, -0.9, 0.27, 0.6],
          [0.34, -0.9, 0.27, -0.6],
          [0, -0.9, -0.35, 0],
        ].map(([x, y, z, rotation]) => (
          <mesh
            key={`${x}-${z}`}
            position={[x, y, z]}
            rotation={[rotation, 0, x === 0 ? 0 : -rotation]}
            castShadow
          >
            <cylinderGeometry args={[0.045, 0.055, 0.68, 12]} />
            <meshStandardMaterial {...cameraMetalMaterial} />
          </mesh>
        ))}
      </group>
      <CameraFrustum
        displayFov={(object.cameraFov ?? 50) * 0.5}
        depth={frustumDepth}
        aspectRatio={aspectRatio}
        highlighted={selected}
      />
    </group>
  );
}

function CameraFrustum({
  displayFov,
  depth,
  aspectRatio,
  highlighted,
}: {
  displayFov: number;
  depth: number;
  aspectRatio: number;
  highlighted: boolean;
}) {
  const lensDepth = CAMERA_GIZMO_LENS_DEPTH;
  const { halfWidth, halfHeight } = getCameraFrustumHalfSize(
    displayFov,
    aspectRatio,
    depth,
  );
  const endDepth = lensDepth + depth;
  const origin: [number, number, number] = [0, 0, lensDepth];
  const corners: [number, number, number][] = [
    [-halfWidth, -halfHeight, endDepth],
    [halfWidth, -halfHeight, endDepth],
    [halfWidth, halfHeight, endDepth],
    [-halfWidth, halfHeight, endDepth],
  ];
  const color = highlighted ? "#fbbf24" : "#7dd3fc";

  return (
    <group>
      {corners.map((corner, index) => (
        <Line
          key={`ray-${index}`}
          points={[origin, corner]}
          color={color}
          lineWidth={highlighted ? 1.15 : 0.75}
          transparent
          opacity={highlighted ? 0.78 : 0.42}
        />
      ))}
      <Line
        points={[...corners, corners[0]]}
        color={color}
        lineWidth={highlighted ? 1.15 : 0.75}
        transparent
        opacity={highlighted ? 0.78 : 0.42}
      />
      <Line
        points={[origin, [0, 0, endDepth]]}
        color={color}
        lineWidth={0.7}
        dashed
        dashScale={3}
        gapSize={1.4}
        transparent
        opacity={0.32}
      />
    </group>
  );
}

function CharacterLabel({
  name,
  position,
  model,
  scale = 1,
}: {
  name: string;
  position?: [number, number, number];
  model?: Object3D;
  scale?: number;
}) {
  // Keep the plate narrow enough to read like a name badge, with a little
  // horizontal padding around the characters. Chinese characters are roughly
  // square at the given font size, Latin letters take about half that width.
  const textWidth = Math.max(name.length * 0.082 + 0.1, 0.24);
  const labelRef = useRef<Group | null>(null);
  const worldPositionRef = useRef(new Vector3());
  const localPositionRef = useRef(new Vector3());
  const worldScaleRef = useRef(new Vector3());

  useFrame(() => {
    if (!model || !labelRef.current) return;
    const headTop = getCharacterBone(model, "HeadTop_End");
    const head = headTop ?? getCharacterBone(model, "Head");
    const parent = labelRef.current.parent;
    if (!head || !parent) return;

    const worldPosition = worldPositionRef.current;
    const localPosition = localPositionRef.current;
    const worldScale = worldScaleRef.current;
    model.updateMatrixWorld(true);
    head.getWorldPosition(worldPosition);
    model.getWorldScale(worldScale);
    // Prefer the top-of-head endpoint so tall hairstyles cannot cover the
    // badge. Older rigs without that endpoint keep the larger Head offset.
    worldPosition.y +=
      (headTop ? 0.1 : 0.18) * Math.max(worldScale.y, 0.001);
    parent.worldToLocal(localPosition.copy(worldPosition));
    labelRef.current.position.copy(localPosition);
  });

  return (
    <Billboard
      ref={labelRef}
      position={position ?? [0, 1.9, 0]}
      scale={scale}
      follow
    >
      <group userData={{ directorTransformHelper: true }} renderOrder={999}>
        <mesh renderOrder={999}>
          <planeGeometry args={[textWidth, 0.105]} />
          <meshBasicMaterial
            color="#171a21"
            transparent
            opacity={0.5}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
        <Text
          position={[0, 0, 0.006]}
          fontSize={0.082}
          color="#f4f4f5"
          anchorX="center"
          anchorY="middle"
          renderOrder={1000}
          material-depthTest={false}
          material-depthWrite={false}
        >
          {name}
        </Text>
      </group>
    </Billboard>
  );
}
