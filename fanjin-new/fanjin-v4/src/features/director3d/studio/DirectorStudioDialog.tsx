"use client";

import {
  Camera,
  Clapperboard,
  CircleHelp,
  Image as ImageIcon,
  Maximize2,
  Moon,
  Sun,
} from "lucide-react";
import { Vector3 } from "three";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DirectorScenePreview,
  type DirectorSceneCapture,
  type DirectorViewOrientation,
  type DirectorViewPreset,
} from "./DirectorScenePreview";
import { DirectorSceneInspector } from "./DirectorSceneInspector";
import { DirectorPoseInspector } from "./DirectorPoseInspector";
import { DirectorSidebar, type CameraPreset } from "./DirectorSidebar";
import {
  ViewCompass,
  type ViewCompassHandle,
} from "./DirectorViewCompass";
import { DecimalNumberInput } from "./DecimalNumberInput";
import {
  CameraSelectField,
  CameraTextField,
  TransformFields,
} from "./DirectorStudioFields";
import {
  clampDirectorPosition,
  createDirectorObject,
  createInitialDirectorStudioState,
  DIRECTOR_CAPTURE_RATIOS,
  DIRECTOR_STAGE,
  getDirectorActiveCamera,
  getDirectorPoseAdjustments,
  getDirectorPositionMode,
  type DirectorObject,
  type DirectorCharacterModel,
  type DirectorObjectKind,
  type DirectorStudioState,
  type DirectorTheme,
  type DirectorViewMode,
} from "./types";
import {
  getCameraTargetFromRotation,
  getUprightCameraRotation,
} from "./camera-orientation";

const DIRECTOR_THEME_VARS: Record<DirectorTheme, Record<string, string>> = {
  dark: {
    "--director-bg": "#202020",
    "--director-panel": "#292929",
    "--director-panel-alt": "#262626",
    "--director-border": "#363636",
    "--director-border-strong": "#3a3a3a",
    "--director-text": "#f4f4f5",
    "--director-text-secondary": "#d4d4d8",
    "--director-text-muted": "#a1a1aa",
    "--director-text-dim": "#71717a",
    "--director-hover": "#2c2c2c",
    "--director-active": "#3d3d3d",
    "--director-control": "#171717",
    "--director-icon-bg": "#383838",
    "--director-accent": "#a5b4fc",
    "--director-accent-soft": "rgba(129, 140, 248, 0.16)",
  },
  light: {
    "--director-bg": "#f7f7f8",
    "--director-panel": "#ffffff",
    "--director-panel-alt": "#f1f1f3",
    "--director-border": "#e0e0e0",
    "--director-border-strong": "#d4d4d8",
    "--director-text": "#18181b",
    "--director-text-secondary": "#3f3f46",
    "--director-text-muted": "#71717a",
    "--director-text-dim": "#9ca3af",
    "--director-hover": "#ececec",
    "--director-active": "#e4e4e7",
    "--director-control": "#e4e4e7",
    "--director-icon-bg": "#e4e4e7",
    "--director-accent": "#6366f1",
    "--director-accent-soft": "rgba(99, 102, 241, 0.12)",
  },
};

interface DirectorStudioDialogProps {
  studio: DirectorStudioState;
  onStudioChange: (studio: DirectorStudioState) => void;
}

export function DirectorStudioDialog({
  studio,
  onStudioChange,
}: DirectorStudioDialogProps) {
  const [theme, setTheme] = useState<DirectorTheme>("dark");
  const [viewMode, setViewMode] = useState<DirectorViewMode>("director");
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(
    studio.objects[0]?.id ?? null,
  );
  const [poseEditingObjectId, setPoseEditingObjectId] = useState<string | null>(
    null,
  );
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isCaptureReady, setIsCaptureReady] = useState(false);
  const [cameraPreviewUrl, setCameraPreviewUrl] = useState<string | null>(null);
  const [cameraPreviewCameraId, setCameraPreviewCameraId] = useState<
    string | null
  >(null);
  const [viewCommand, setViewCommand] = useState<{
    id: number;
    preset: DirectorViewPreset;
  } | null>(null);
  const [focusObjectCommand, setFocusObjectCommand] = useState<{
    id: number;
    objectId: string;
  } | null>(null);
  const captureRef = useRef<DirectorSceneCapture | null>(null);
  const compassRef = useRef<ViewCompassHandle | null>(null);

  const updateStudio = (next: DirectorStudioState) => onStudioChange(next);
  const registerCapture = useCallback((capture: DirectorSceneCapture) => {
    captureRef.current = capture;
    setIsCaptureReady((current) => current || true);
  }, []);
  const updateViewOrientation = useCallback(
    (nextOrientation: DirectorViewOrientation) => {
      compassRef.current?.updateOrientation(nextOrientation);
    },
    [],
  );
  const selectedCameraId =
    studio.objects.find((object) => object.id === selectedObjectId)?.kind ===
    "camera"
      ? selectedObjectId
      : null;
  const selectedObject = selectedObjectId
    ? (studio.objects.find((object) => object.id === selectedObjectId) ?? null)
    : null;

  useEffect(() => {
    if (
      selectedObjectId &&
      studio.objects.some((object) => object.id === selectedObjectId)
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => setSelectedObjectId(studio.objects[0]?.id ?? null),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [selectedObjectId, studio.objects]);

  useEffect(() => {
    if (
      !isCaptureReady ||
      (viewMode !== "camera" && !selectedCameraId)
    ) {
      return;
    }

    let cancelled = false;
    void captureRef.current?.captureCamera(selectedCameraId).then((capture) => {
      if (!capture || cancelled) return;
      const nextPreviewUrl = URL.createObjectURL(capture.blob);
      if (cancelled) {
        URL.revokeObjectURL(nextPreviewUrl);
        return;
      }
      setCameraPreviewCameraId(selectedCameraId);
      setCameraPreviewUrl(nextPreviewUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [
    isCaptureReady,
    selectedCameraId,
    studio.camera,
    studio.captureRatio,
    studio.objects,
    studio.scene.panoramaRadius,
    studio.scene.panoramaRotation,
    studio.scene.position,
    studio.scene.rotation,
    studio.scene.skyColor,
    viewMode,
  ]);

  useEffect(
    () => () => {
      if (cameraPreviewUrl) URL.revokeObjectURL(cameraPreviewUrl);
    },
    [cameraPreviewUrl],
  );

  const addObject = (
    kind: DirectorObjectKind,
    namePrefix?: string,
    characterModel?: DirectorCharacterModel,
  ) => {
    const object = createDirectorObject(
      kind,
      namePrefix,
      characterModel,
      studio.objects
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.name),
    );
    const position = object.position.map((value) =>
      studio.scene.snapToGrid ? Math.round(value * 2) / 2 : value,
    ) as [number, number, number];
    if (studio.scene.snapToGround) {
      position[1] = Math.max(position[1], 0);
    }
    const placedObject = {
      ...object,
      position: clampDirectorPosition(
        position,
        getDirectorPositionMode(object.kind),
      ),
    };
    updateStudio({ ...studio, objects: [...studio.objects, placedObject] });
    setSelectedObjectId(placedObject.id);
    setPoseEditingObjectId(null);
  };

  const addCamera = (preset: CameraPreset | null) => {
    const object = createDirectorObject(
      "camera",
      preset?.label ?? "当前机位",
      "adult-male",
      studio.objects
        .filter((entry) => entry.kind === "camera")
        .map((entry) => entry.name),
    );
    const position = (preset?.position ?? studio.camera.position).map(
      (value) => (studio.scene.snapToGrid ? Math.round(value * 2) / 2 : value),
    ) as [number, number, number];
    if (studio.scene.snapToGround) {
      position[1] = Math.max(position[1], DIRECTOR_STAGE.cameraMinHeight);
    }
    const cameraFov = preset?.fov ?? studio.camera.fov;
    const cameraObject = {
      ...object,
      position: clampDirectorPosition(position, "camera"),
      cameraFov,
      cameraTargetObjectId: studio.camera.targetObjectId,
      cameraTargetPosition: studio.camera.targetPosition,
    };

    updateStudio({
      ...studio,
      objects: [...studio.objects, cameraObject],
      camera: {
        ...studio.camera,
        position: cameraObject.position,
        fov: cameraFov,
      },
    });
    setSelectedObjectId(cameraObject.id);
    setPoseEditingObjectId(null);
  };

  const selectObject = (objectId: string | null) => {
    setSelectedObjectId(objectId);
    if (objectId !== poseEditingObjectId) setPoseEditingObjectId(null);
  };

  const updateObjectTransform = useCallback(
    (
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
    ) => {
      const movingObject = studio.objects.find(
        (object) => object.id === objectId,
      );
      if (!movingObject) return;

      let nextPosition = patch.position ?? movingObject.position;
      if (studio.scene.snapToGrid) {
        nextPosition = nextPosition.map(
          (value) => Math.round(value * 2) / 2,
        ) as [number, number, number];
      }
      nextPosition = clampDirectorPosition(
        nextPosition,
        getDirectorPositionMode(movingObject.kind),
      );

      const targetObjectId = Object.prototype.hasOwnProperty.call(patch, "cameraTargetObjectId")
        ? (patch.cameraTargetObjectId ?? null)
        : movingObject.cameraTargetObjectId !== undefined
          ? movingObject.cameraTargetObjectId
          : studio.camera.targetObjectId;
      const targetObject = targetObjectId
        ? studio.objects.find((object) => object.id === targetObjectId)
        : null;
      const targetPosition: [number, number, number] = targetObject
        ? ([
            targetObject.position[0],
            targetObject.position[1] + 1,
            targetObject.position[2],
          ] as [number, number, number])
        : (patch.cameraTargetPosition ??
          movingObject.cameraTargetPosition ??
          studio.camera.targetPosition);
      const nextObjects = studio.objects.map((object) =>
        object.id === objectId
          ? {
              ...object,
              ...patch,
              ...(patch.position ? { position: nextPosition } : {}),
              ...(object.kind === "camera"
                ? {
                    cameraTargetObjectId: targetObjectId,
                    cameraTargetPosition: targetPosition,
                    rotation: getUprightCameraRotation(
                      nextPosition,
                      targetPosition,
                      [0, 0, 0],
                    ),
                  }
                : {}),
            }
          : object,
      );

      onStudioChange({
        ...studio,
        objects: nextObjects,
        camera:
          movingObject.kind === "camera"
            ? {
                ...studio.camera,
                ...(patch.position ? { position: nextPosition } : {}),
                targetObjectId,
                targetPosition,
              }
            : studio.camera,
      });
    },
    [onStudioChange, studio],
  );

  const removeSelectedObject = useCallback(() => {
    if (!selectedObjectId) return;
    const selectedObject = studio.objects.find(
      (object) => object.id === selectedObjectId,
    );
    if (
      selectedObject?.kind === "camera" &&
      studio.objects.filter((object) => object.kind === "camera").length <= 1
    ) {
      setCaptureError("至少保留一个机位，当前机位未删除");
      return;
    }
    const removedObjectId = selectedObjectId;
    const objects = studio.objects.filter(
      (object) => object.id !== selectedObjectId,
    );
    const cleanedObjects = objects.map((object) =>
      object.kind === "camera" &&
      object.cameraTargetObjectId === removedObjectId
        ? { ...object, cameraTargetObjectId: null }
        : object,
    );
    onStudioChange({
      ...studio,
      objects: cleanedObjects,
      camera: {
        ...studio.camera,
        targetObjectId:
          studio.camera.targetObjectId === removedObjectId
            ? null
            : studio.camera.targetObjectId,
      },
    });
    setSelectedObjectId(cleanedObjects[0]?.id ?? null);
    setPoseEditingObjectId(null);
  }, [onStudioChange, selectedObjectId, studio]);

  useEffect(() => {
    if (!selectedObjectId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" || isTextEditingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      removeSelectedObject();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, {
        capture: true,
      });
  }, [selectedObjectId, removeSelectedObject]);

  const downloadCapture = async () => {
    setCaptureError(null);
    setIsCapturing(true);
    try {
      const capture = await captureRef.current?.capture();
      if (!capture) throw new Error("3D 画面尚未准备完成，请稍后重试");
      const filename = `导演台截图-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, "-")}.png`;
      const url = URL.createObjectURL(capture.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "截图下载失败");
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <main
      style={DIRECTOR_THEME_VARS[theme] as CSSProperties}
      className="grid h-full min-h-[640px] w-full grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden bg-[var(--director-bg)] p-0 text-[var(--director-text)]"
    >
        <header className="flex items-center justify-between border-b border-[var(--director-border)] px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--director-icon-bg)] text-[var(--director-text)]">
              <Clapperboard className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-[var(--director-text)]">
                导演台
              </p>
              <p className="mt-0.5 text-xs text-[var(--director-text-muted)]">
                搭建场景、调整机位；由繁景保存到当前项目，可下载取景截图
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg bg-[var(--director-control)] p-1 text-xs">
              <ViewButton
                active={viewMode === "director"}
                icon={<Clapperboard className="h-3.5 w-3.5" />}
                label="导演视角"
                onClick={() => setViewMode("director")}
              />
              <ViewButton
                active={viewMode === "camera"}
                icon={<Camera className="h-3.5 w-3.5" />}
                label="机位视角"
                onClick={() => setViewMode("camera")}
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setTheme((current) =>
                  current === "dark" ? "light" : "dark",
                )
              }
              title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--director-border)] bg-[var(--director-panel)] text-[var(--director-text-muted)] transition hover:text-[var(--director-text)]"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        </header>

        <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)_340px]">
          <DirectorSidebar
            studio={studio}
            selectedObjectId={selectedObjectId}
            onSelectObject={selectObject}
            onAddObject={addObject}
            onAddCamera={addCamera}
          />

          <section className="relative min-h-0 overflow-hidden bg-[var(--director-control)]">
            <div className="absolute inset-0">
              <DirectorScenePreview
                studio={studio}
                theme={theme}
                viewMode={viewMode}
                selectedObjectId={selectedObjectId}
                poseEditingObjectId={poseEditingObjectId}
                viewCommand={viewCommand}
                focusObjectCommand={focusObjectCommand}
                onSelectObject={selectObject}
                onObjectTransformCommit={updateObjectTransform}
                onSceneScaleChange={(scale) =>
                  updateStudio({
                    ...studio,
                    scene: { ...studio.scene, scale },
                  })
                }
                onViewOrientationChange={updateViewOrientation}
                onCaptureReady={registerCapture}
              />
            </div>
            {viewMode === "director" && (
              <ViewCompass
                ref={compassRef}
                onSelect={(preset) => {
                  setViewMode("director");
                  setViewCommand((current) => ({
                    id: (current?.id ?? 0) + 1,
                    preset,
                  }));
                }}
              />
            )}
            <div className="absolute bottom-5 left-5 rounded-lg border border-[var(--director-border-strong)] bg-[var(--director-bg)]/95 px-3 py-2 text-[11px] text-[var(--director-text-dim)] backdrop-blur">
              {viewMode === "director"
                ? "导演视角 · 拖动以观察并确定构图"
                : "机位视角 · 使用当前摄像机 FOV 与注视目标"}
              {` · 截图 ${studio.captureRatio}`}
            </div>
          </section>

          <aside className="min-h-0 overflow-y-auto border-l border-[var(--director-border)] bg-[var(--director-panel)] shadow-[-14px_0_32px_rgba(0,0,0,0.08)]">
            {selectedCameraId ? (
              <CameraInspector
                studio={studio}
                selectedCameraId={selectedCameraId}
                previewUrl={
                  selectedCameraId === cameraPreviewCameraId
                    ? cameraPreviewUrl
                    : null
                }
                onChange={updateStudio}
                onSelectCamera={selectObject}
              />
            ) : viewMode === "director" && selectedObject ? (
              <ObjectInspector
                key={selectedObject.id}
                studio={studio}
                objectId={selectedObject.id}
                onChange={updateStudio}
                onExitPose={() => setPoseEditingObjectId(null)}
                onEnterPose={() => {
                  setViewMode("director");
                  setPoseEditingObjectId(selectedObject.id);
                  setFocusObjectCommand((current) => ({
                    id: (current?.id ?? 0) + 1,
                    objectId: selectedObject.id,
                  }));
                }}
              />
            ) : viewMode === "director" ? (
              <DirectorSceneInspector
                studio={studio}
                onChange={updateStudio}
                onReset={() =>
                  updateStudio({
                    ...studio,
                    scene: createInitialDirectorStudioState().scene,
                  })
                }
              />
            ) : (
              <CameraInspector
                studio={studio}
                selectedCameraId={null}
                previewUrl={cameraPreviewUrl}
                onChange={updateStudio}
                onSelectCamera={selectObject}
              />
            )}
            <div className="border-t border-[var(--director-border)] bg-[var(--director-panel-alt)] p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--director-text-dim)]">输出</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {DIRECTOR_CAPTURE_RATIOS.map((ratio) => (
                  <button
                    key={ratio.value}
                    type="button"
                    onClick={() =>
                      updateStudio({ ...studio, captureRatio: ratio.value })
                    }
                    className={`rounded-lg border px-2 py-1.5 text-[11px] transition ${
                      studio.captureRatio === ratio.value
                        ? "border-[var(--director-accent)] bg-[var(--director-accent-soft)] text-[var(--director-text)]"
                        : "border-[var(--director-border)] bg-[var(--director-panel)] text-[var(--director-text-dim)] hover:border-[var(--director-border-strong)] hover:bg-[var(--director-hover)]"
                    }`}
                  >
                    {ratio.label}
                  </button>
                ))}
              </div>
              {captureError && (
                <p className="mt-2 text-[11px] text-red-300">{captureError}</p>
              )}
              <button
                type="button"
                disabled={isCapturing}
                onClick={downloadCapture}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--director-accent)] px-3 py-3 text-xs font-semibold text-[#17171b] shadow-[0_8px_20px_rgba(99,102,241,0.18)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                {isCapturing ? "正在生成…" : "下载 PNG 截图"}
              </button>
            </div>
          </aside>
        </div>
    </main>
  );
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function ViewButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition ${
        active
          ? "bg-[var(--director-active)] text-[var(--director-text)]"
          : "text-[var(--director-text-muted)] hover:text-[var(--director-text-secondary)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ObjectInspector({
  studio,
  objectId,
  onChange,
  onEnterPose,
  onExitPose,
}: {
  studio: DirectorStudioState;
  objectId: string;
  onChange: (studio: DirectorStudioState) => void;
  onEnterPose: () => void;
  onExitPose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"properties" | "pose">(
    "properties",
  );
  const object = studio.objects.find((entry) => entry.id === objectId);
  if (!object || object.kind === "camera") return null;

  const title = {
    character: "角色",
    crowd: "群众",
    cube: "场景方块",
    sphere: "场景球体",
  }[object.kind];
  const updateObject = (patch: Partial<DirectorObject>) =>
    onChange({
      ...studio,
      objects: studio.objects.map((entry) =>
        entry.id === objectId ? { ...entry, ...patch } : entry,
      ),
    });
  const rotationDegrees = object.rotation.map((value) =>
    Number(((value * 180) / Math.PI).toFixed(2)),
  ) as [number, number, number];

  return (
    <section className="bg-[var(--director-panel)] pb-6">
      <div className="border-b border-[var(--director-border)] px-5 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--director-accent)]">选中对象</p>
        <p className="mt-1.5 text-base font-semibold tracking-tight text-[var(--director-text)]">{title}</p>
      </div>
      <div className="flex gap-2 border-b border-[var(--director-border)] bg-[var(--director-panel-alt)] px-5 py-3 text-xs">
        <button
          type="button"
          onClick={() => {
            setActiveTab("properties");
            onExitPose();
          }}
          className={`rounded-md px-3 py-1.5 font-medium ${
            activeTab === "properties"
              ? "bg-[var(--director-accent-soft)] text-[var(--director-text)] ring-1 ring-[var(--director-accent)]"
              : "text-[var(--director-text-muted)] hover:text-[var(--director-text-secondary)]"
          }`}
        >
          属性
        </button>
        {object.kind === "character" && (
          <button
            type="button"
            onClick={() => {
              setActiveTab("pose");
              onEnterPose();
            }}
            className={`rounded-md px-3 py-1.5 font-medium ${
              activeTab === "pose"
                ? "bg-[var(--director-accent-soft)] text-[var(--director-text)] ring-1 ring-[var(--director-accent)]"
                : "text-[var(--director-text-muted)] hover:text-[var(--director-text-secondary)]"
            }`}
          >
            姿势
          </button>
        )}
        {object.kind === "crowd" && (
          <button
            type="button"
            disabled
            title="群众阵列尚未接入独立骨架"
            className="rounded-md px-3 py-1.5 text-[var(--director-text-dim)] disabled:cursor-not-allowed"
          >
            姿势
          </button>
        )}
      </div>

      {activeTab === "pose" && object.kind === "character" ? (
        <DirectorPoseInspector
          key={object.id}
          value={object.posePreset ?? "standing"}
          adjustments={getDirectorPoseAdjustments(
            object.posePreset ?? "standing",
            object.poseAdjustments,
          )}
          onPresetChange={(posePreset) =>
            updateObject({
              posePreset,
              poseAdjustments: getDirectorPoseAdjustments(posePreset),
              poseJointRotations: {},
            })
          }
          onAdjustmentsChange={(poseAdjustments) =>
            updateObject({ poseAdjustments })
          }
        />
      ) : (
        <div className="px-5 pt-5">
          <CameraTextField
            label="名称"
            value={object.name}
            onChange={(name) => updateObject({ name })}
          />
          <TransformFields
            label="位置"
            value={object.position}
            limits={[
              [
                -DIRECTOR_STAGE.objectHorizontalLimit,
                DIRECTOR_STAGE.objectHorizontalLimit,
              ],
              [
                object.kind === "character" || object.kind === "crowd"
                  ? DIRECTOR_STAGE.characterMinHeight
                  : DIRECTOR_STAGE.objectMinHeight,
                DIRECTOR_STAGE.objectMaxHeight,
              ],
              [
                -DIRECTOR_STAGE.objectHorizontalLimit,
                DIRECTOR_STAGE.objectHorizontalLimit,
              ],
            ]}
            onChange={(position) =>
              updateObject({
                position: clampDirectorPosition(
                  position,
                  getDirectorPositionMode(object.kind),
                ),
              })
            }
          />
          <TransformFields
            label="旋转"
            value={rotationDegrees}
            suffix="°"
            limits={[
              [-360, 360],
              [-360, 360],
              [-360, 360],
            ]}
            onChange={(rotation) =>
              updateObject({
                rotation: rotation.map((value) => (value * Math.PI) / 180) as [
                  number,
                  number,
                  number,
                ],
              })
            }
          />
          <TransformFields
            label="缩放"
            value={object.scale}
            limits={[
              [0.1, 10],
              [0.1, 10],
              [0.1, 10],
            ]}
            onChange={(scale) => updateObject({ scale })}
          />

          <label className="mt-4 block text-[11px] text-[var(--director-text-muted)]">
            统一缩放
            <span className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={0.1}
                max={5}
                step={0.01}
                value={object.uniformScale}
                onChange={(event) =>
                  updateObject({ uniformScale: Number(event.target.value) })
                }
                className="min-w-0 flex-1 accent-cyan-300"
              />
              <span className="w-[60px] rounded-md bg-[var(--director-border-strong)] px-2 py-1.5 text-center text-xs font-medium text-[var(--director-text)]">
                <DecimalNumberInput
                  value={object.uniformScale}
                  min={0.1}
                  max={5}
                  step={0.01}
                  precision={2}
                  onValueChange={(uniformScale) =>
                    updateObject({ uniformScale })
                  }
                  className="w-full bg-transparent text-center outline-none"
                  ariaLabel="统一缩放"
                />
              </span>
            </span>
          </label>

          <label className="mt-4 block text-[11px] text-[var(--director-text-muted)]">
            颜色
            <span className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={object.color}
                onChange={(event) =>
                  updateObject({ color: event.target.value })
                }
                className="h-8 w-8 cursor-pointer rounded-lg border-0 bg-transparent p-0"
                aria-label="模型颜色"
              />
              <input
                key={object.color}
                defaultValue={object.color.toUpperCase()}
                maxLength={7}
                onBlur={(event) => {
                  const color = event.target.value;
                  if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                    updateObject({ color: color.toUpperCase() });
                  } else {
                    event.target.value = object.color.toUpperCase();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="min-w-0 flex-1 rounded-lg border-0 bg-[var(--director-border-strong)] px-2.5 py-2 text-xs font-medium uppercase text-[var(--director-text)] outline-none focus:ring-1 focus:ring-zinc-500"
                aria-label="模型颜色十六进制值"
              />
            </span>
          </label>
        </div>
      )}
    </section>
  );
}

function CameraInspector({
  studio,
  selectedCameraId,
  previewUrl,
  onChange,
  onSelectCamera,
}: {
  studio: DirectorStudioState;
  selectedCameraId: string | null;
  previewUrl: string | null;
  onChange: (studio: DirectorStudioState) => void;
  onSelectCamera: (cameraId: string | null) => void;
}) {
  const selectedCamera = selectedCameraId
    ? (studio.objects.find((object) => object.id === selectedCameraId) ?? null)
    : null;
  const camera = getDirectorActiveCamera(studio, selectedCameraId);
  const cameraTargetObject = camera.targetObjectId
    ? studio.objects.find((object) => object.id === camera.targetObjectId)
    : null;
  const cameraAimTarget: [number, number, number] = cameraTargetObject
    ? [
        cameraTargetObject.position[0],
        cameraTargetObject.position[1] + 1,
        cameraTargetObject.position[2],
      ]
    : camera.targetPosition;
  const cameraRotation = getUprightCameraRotation(
    camera.position,
    cameraAimTarget,
    [0, 0, 0],
  );
  const updateCamera = (patch: Partial<DirectorStudioState["camera"]>) =>
    onChange({
      ...studio,
      camera: { ...camera, ...patch },
      objects: selectedCameraId
        ? studio.objects.map((object) => {
            if (object.id !== selectedCameraId) return object;

            const nextPosition = patch.position ?? object.position;
            const nextTargetObjectId = Object.prototype.hasOwnProperty.call(patch, "targetObjectId")
              ? (patch.targetObjectId ?? null)
              : camera.targetObjectId;
            const nextTargetPosition =
              patch.targetPosition ?? camera.targetPosition;
            const nextTargetObject = nextTargetObjectId
              ? studio.objects.find((entry) => entry.id === nextTargetObjectId)
              : null;
            const nextAimTarget: [number, number, number] = nextTargetObject
              ? [
                  nextTargetObject.position[0],
                  nextTargetObject.position[1] + 1,
                  nextTargetObject.position[2],
                ]
              : nextTargetPosition;

            return {
              ...object,
              ...(patch.position ? { position: patch.position } : {}),
              ...(patch.fov !== undefined ? { cameraFov: patch.fov } : {}),
              ...(Object.prototype.hasOwnProperty.call(patch, "targetObjectId")
                ? { cameraTargetObjectId: patch.targetObjectId ?? null }
                : {}),
              ...(patch.targetPosition
                ? { cameraTargetPosition: patch.targetPosition }
                : {}),
              rotation: getUprightCameraRotation(
                nextPosition,
                nextAimTarget,
                [0, 0, 0],
              ),
            };
          })
        : studio.objects,
    });
  const updateSelectedCamera = (
    patch: Partial<Pick<DirectorObject, "name">>,
  ) => {
    if (!selectedCameraId) return;
    onChange({
      ...studio,
      objects: studio.objects.map((object) =>
        object.id === selectedCameraId ? { ...object, ...patch } : object,
      ),
    });
  };
  const cameras = studio.objects.filter((object) => object.kind === "camera");

  return (
    <section className="border-b border-[var(--director-border)] pb-5">
          <div className="border-b border-[var(--director-border)] px-5 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--director-accent)]">选中对象</p>
        <p className="mt-1.5 text-base font-semibold tracking-tight text-[var(--director-text)]">摄像机</p>
      </div>
      <div className="flex gap-4 border-b border-[var(--director-border)] bg-[var(--director-panel-alt)] px-5 pt-3 text-xs">
        <button
          type="button"
          className="rounded-lg bg-[var(--director-accent-soft)] px-3 py-1.5 font-medium text-[var(--director-text)] ring-1 ring-[var(--director-accent)]"
        >
          属性
        </button>
        <span className="px-1 py-1.5 text-[var(--director-text-muted)]" aria-hidden="true">
          截图
        </span>
      </div>
      <div className="px-5 pt-5">
        <CameraPreview fov={camera.fov} previewUrl={previewUrl} />
      </div>
      <div className="mt-4 border-t border-[var(--director-border)] px-4 pt-4">
        <CameraTextField
          label="名称"
          value={selectedCamera?.name ?? "当前摄像机"}
          onChange={(name) => updateSelectedCamera({ name })}
          disabled={!selectedCamera}
        />
        <CameraSelectField
          label="切换机位"
          value={selectedCameraId ?? ""}
          onChange={(value) => onSelectCamera(value || null)}
        >
          <option value="">当前摄像机</option>
          {cameras.map((object) => (
            <option key={object.id} value={object.id}>
              {object.name}
            </option>
          ))}
        </CameraSelectField>
      </div>
      <div className="px-4">
        <TransformFields
          label="位置"
          value={camera.position}
          limits={[
            [
              -DIRECTOR_STAGE.cameraHorizontalLimit,
              DIRECTOR_STAGE.cameraHorizontalLimit,
            ],
            [DIRECTOR_STAGE.cameraMinHeight, DIRECTOR_STAGE.cameraMaxHeight],
            [
              -DIRECTOR_STAGE.cameraHorizontalLimit,
              DIRECTOR_STAGE.cameraHorizontalLimit,
            ],
          ]}
          onChange={(position) =>
            updateCamera({
              position: clampDirectorPosition(position, "camera"),
            })
          }
        />
        <CameraSelectField label="跟随目标" value="none" disabled>
          <option value="none">无跟随</option>
        </CameraSelectField>
        <TransformFields
          label="旋转"
          value={
            cameraRotation.map((value) =>
              Number(((value * 180) / Math.PI).toFixed(2)),
            ) as [number, number, number]
          }
          suffix="°"
          onChange={(rotation) => {
            const radians = rotation.map(
              (value) => (value * Math.PI) / 180,
            ) as [number, number, number];
            const targetDistance = Math.max(
              0.01,
              new Vector3(...camera.position).distanceTo(
                new Vector3(...cameraAimTarget),
              ),
            );
            updateCamera({
              targetObjectId: null,
              targetPosition: clampDirectorPosition(
                getCameraTargetFromRotation(
                  camera.position,
                  radians,
                  targetDistance,
                ),
                "target",
              ),
            });
          }}
        />
        <CameraSelectField
          label="注视目标"
          value={camera.targetObjectId ?? "__manual__"}
          onChange={(value) =>
            updateCamera({
              targetObjectId: value === "__manual__" ? null : value,
            })
          }
        >
          <option value="__manual__">手动坐标</option>
          {studio.objects
            .filter((object) => object.id !== selectedCameraId)
            .map((object) => (
            <option key={object.id} value={object.id}>
              {object.name}
            </option>
            ))}
        </CameraSelectField>
        <TransformFields
          label="注视坐标"
          value={camera.targetPosition}
          limits={[
            [-DIRECTOR_STAGE.halfSize, DIRECTOR_STAGE.halfSize],
            [DIRECTOR_STAGE.targetMinHeight, DIRECTOR_STAGE.targetMaxHeight],
            [-DIRECTOR_STAGE.halfSize, DIRECTOR_STAGE.halfSize],
          ]}
          onChange={(targetPosition) =>
            updateCamera({
              targetObjectId: null,
              targetPosition: clampDirectorPosition(targetPosition, "target"),
            })
          }
        />
      </div>
      <div className="mt-5 border-t border-[var(--director-border)] px-4 pt-4">
        <label className="flex items-center gap-1 text-xs font-medium text-[var(--director-text-secondary)]">
          视野角度 (FOV)
          <CircleHelp className="h-3.5 w-3.5 text-[var(--director-text-dim)]" />
        </label>
        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={20}
            max={100}
            step="0.1"
            value={camera.fov}
            onChange={(event) =>
              updateCamera({ fov: Number(event.target.value) })
            }
            className="min-w-0 flex-1 accent-cyan-300"
          />
          <div className="w-[60px] rounded-md bg-[var(--director-border-strong)] px-2 py-1.5 text-center text-xs font-medium text-[var(--director-text)]">
            <DecimalNumberInput
              value={camera.fov}
              min={20}
              max={100}
              step="0.1"
              precision={1}
              onValueChange={(fov) => updateCamera({ fov })}
              className="w-full bg-transparent text-center outline-none"
              ariaLabel="视野角度 FOV"
            />
          </div>
        </div>
      </div>
      <div className="mt-5 border-t border-[var(--director-border)] px-4 pt-4">
        <p className="text-sm font-semibold text-[var(--director-text)]">相机截图</p>
      </div>
    </section>
  );
}

function CameraPreview({
  fov,
  previewUrl,
}: {
  fov: number;
  previewUrl: string | null;
}) {
  return (
    <div className="relative h-32 overflow-hidden rounded-xl border border-[var(--director-border)] bg-[#060607]">
      {previewUrl ? (
        <div
          role="img"
          aria-label="当前机位取景预览"
          className="h-full w-full bg-cover bg-center"
          style={{ backgroundImage: `url(${previewUrl})` }}
        />
      ) : (
        <div className="grid h-full place-items-center text-xs text-[var(--director-text-dim)]">
          正在生成机位取景预览…
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-9 bg-gradient-to-b from-black/65 to-transparent" />
      <span className="absolute left-3 top-2 text-xs font-medium text-[var(--director-text-secondary)]">
        FOV {fov.toFixed(0)}°
      </span>
      <span
        className="absolute bottom-3 right-3 grid h-6 w-6 place-items-center rounded-md bg-zinc-700/80 text-[var(--director-text-secondary)]"
        aria-hidden="true"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}
