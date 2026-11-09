export type DirectorObjectKind =
  "character" | "cube" | "sphere" | "crowd" | "camera";
export type DirectorTheme = "dark" | "light";
export const DIRECTOR_CHARACTER_MODEL_VALUES = [
  "adult-male",
  "adult-female",
  "teenager",
  "young-child",
  "slender",
  "broad",
  "chibi",
  "muscular",
] as const;
export type DirectorCharacterModel =
  (typeof DIRECTOR_CHARACTER_MODEL_VALUES)[number];

/** Runtime visual correction that aligns procedural body profiles on the stage. */
export const DIRECTOR_CHARACTER_VISUAL_SCALES: Readonly<
  Record<DirectorCharacterModel, number>
> = {
  "adult-male": 1.57,
  "adult-female": 1.5,
  teenager: 1.11,
  "young-child": 1,
  slender: 1.57,
  broad: 1.6,
  chibi: 0.8,
  muscular: 1.15,
};

export function getDirectorCharacterVisualScale(
  characterModel: DirectorCharacterModel | undefined,
): number {
  return DIRECTOR_CHARACTER_VISUAL_SCALES[characterModel ?? "adult-male"];
}
export type DirectorViewMode = "director" | "camera";
export type DirectorCaptureRatio = "16:9" | "9:16" | "1:1" | "4:3";
export const DIRECTOR_POSE_PRESET_VALUES = [
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
] as const;

export type DirectorPosePreset =
  (typeof DIRECTOR_POSE_PRESET_VALUES)[number];

export type DirectorPoseJointId =
  | "head"
  | "chest"
  | "pelvis"
  | "root"
  | "leftShoulder"
  | "leftElbow"
  | "leftHand"
  | "rightShoulder"
  | "rightElbow"
  | "rightHand"
  | "leftHip"
  | "leftKnee"
  | "leftAnkle"
  | "rightHip"
  | "rightKnee"
  | "rightAnkle";

export type DirectorPoseJointRotations = Partial<
  Record<DirectorPoseJointId, [number, number, number, number]>
>;

export interface DirectorPoseAdjustments {
  bodyPitch: number;
  bodyTurn: number;
  bodyRoll: number;
  torsoPitch: number;
  torsoTwist: number;
  torsoRoll: number;
  headNod: number;
  headTurn: number;
  headTilt: number;
  leftShoulderForward: number;
  leftShoulderOut: number;
  leftShoulderTwist: number;
  rightShoulderForward: number;
  rightShoulderOut: number;
  rightShoulderTwist: number;
  leftElbowBend: number;
  rightElbowBend: number;
  leftHipForward: number;
  leftHipOut: number;
  leftHipTwist: number;
  rightHipForward: number;
  rightHipOut: number;
  rightHipTwist: number;
  leftKneeBend: number;
  rightKneeBend: number;
}

export const DIRECTOR_STAGE = {
  size: 20,
  halfSize: 10,
  objectHorizontalLimit: 9,
  objectMinHeight: 0,
  objectMaxHeight: 10,
  characterMinHeight: -10,
  cameraHorizontalLimit: 15,
  cameraMinHeight: 0.25,
  cameraMaxHeight: 12,
  targetMinHeight: 0,
  targetMaxHeight: 10,
  coordinateStep: 0.01,
} as const;

/** Default overview scale for a newly opened director-studio scene. */
export const DIRECTOR_DEFAULT_SCENE_SCALE = 3;

export interface DirectorObject {
  id: string;
  name: string;
  kind: DirectorObjectKind;
  color: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  uniformScale: number;
  visible: boolean;
  characterModel?: DirectorCharacterModel;
  posePreset?: DirectorPosePreset;
  poseAdjustments?: DirectorPoseAdjustments;
  poseJointRotations?: DirectorPoseJointRotations;
  cameraFov?: number;
  cameraTargetObjectId?: string | null;
  cameraTargetPosition?: [number, number, number];
}

export interface DirectorStudioState {
  objects: DirectorObject[];
  /** Marks data written after the default physical camera migration. */
  cameraSetupInitialized: boolean;
  scene: {
    /** 编辑视图缩放的迁移标记；缺失时按旧的整体缩放状态回退。 */
    viewScaleInitialized: boolean;
    scale: number;
    position: [number, number, number];
    rotation: [number, number, number];
    skyColor: string;
    panoramaRotation: number;
    panoramaRadius: number;
    showCharacterLabels: boolean;
    snapToGrid: boolean;
    snapToGround: boolean;
    groundVisible: boolean;
    groundOpacity: number;
  };
  camera: {
    position: [number, number, number];
    fov: number;
    targetObjectId: string | null;
    targetPosition: [number, number, number];
  };
  captureRatio: DirectorCaptureRatio;
}

/** Resolve the physical camera used by the camera view and camera preview. */
export function getDirectorActiveCamera(
  studio: DirectorStudioState,
  selectedObjectId: string | null,
): DirectorStudioState["camera"] {
  const selectedCamera = selectedObjectId
    ? studio.objects.find(
        (object) => object.id === selectedObjectId && object.kind === "camera",
      )
    : null;

  if (!selectedCamera) return studio.camera;

  return {
    ...studio.camera,
    position: selectedCamera.position,
    fov: selectedCamera.cameraFov ?? studio.camera.fov,
    targetObjectId:
      selectedCamera.cameraTargetObjectId !== undefined
        ? selectedCamera.cameraTargetObjectId
        : studio.camera.targetObjectId,
    targetPosition:
      selectedCamera.cameraTargetPosition ?? studio.camera.targetPosition,
  };
}

export const DIRECTOR_CAPTURE_RATIOS: Array<{
  value: DirectorCaptureRatio;
  label: string;
}> = [
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
  { value: "1:1", label: "1:1 方形" },
  { value: "4:3", label: "4:3 标准" },
];

export const directorObjectLabels: Record<DirectorObjectKind, string> = {
  character: "角色",
  cube: "方块",
  sphere: "圆球",
  crowd: "群众",
  camera: "机位",
};

const DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS: DirectorPoseAdjustments = {
  bodyPitch: 0,
  bodyTurn: 0,
  bodyRoll: 0,
  torsoPitch: 0,
  torsoTwist: 0,
  torsoRoll: 0,
  headNod: 0,
  headTurn: 0,
  headTilt: 0,
  leftShoulderForward: 0,
  leftShoulderOut: 0,
  leftShoulderTwist: 0,
  rightShoulderForward: 0,
  rightShoulderOut: 0,
  rightShoulderTwist: 0,
  leftElbowBend: 0,
  rightElbowBend: 0,
  leftHipForward: 0,
  leftHipOut: 0,
  leftHipTwist: 0,
  rightHipForward: 0,
  rightHipOut: 0,
  rightHipTwist: 0,
  leftKneeBend: 0,
  rightKneeBend: 0,
};

const DIRECTOR_T_POSE_ADJUSTMENTS: DirectorPoseAdjustments = {
  ...DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS,
  leftShoulderForward: 16,
  leftShoulderOut: 60,
  leftShoulderTwist: 40,
  rightShoulderForward: 22,
  rightShoulderOut: 54,
  rightShoulderTwist: 41,
};

const DIRECTOR_WALKING_POSE_ADJUSTMENTS: DirectorPoseAdjustments = {
  ...DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS,
  torsoPitch: 3,
  torsoTwist: 5,
  headNod: -5,
  leftShoulderForward: 40,
  leftShoulderOut: 9,
  leftShoulderTwist: 0,
  rightShoulderForward: -8,
  rightShoulderOut: 27,
  rightShoulderTwist: -4,
  leftElbowBend: 37,
  rightElbowBend: 26,
  leftHipForward: -10,
  leftHipOut: 0,
  leftHipTwist: 0,
  rightHipForward: 36,
  rightHipOut: -2,
  rightHipTwist: 0,
  leftKneeBend: 22,
  rightKneeBend: 41,
};

const DIRECTOR_RUNNING_POSE_ADJUSTMENTS: DirectorPoseAdjustments = {
  ...DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS,
  bodyPitch: -2,
  torsoPitch: 3,
  torsoTwist: 5,
  headNod: -10,
  leftShoulderForward: -26,
  leftShoulderOut: 23,
  leftShoulderTwist: 14,
  rightShoulderForward: 23,
  rightShoulderOut: 14,
  rightShoulderTwist: 19,
  leftElbowBend: 60,
  rightElbowBend: 89,
  leftHipForward: 50,
  leftHipOut: 0,
  leftHipTwist: 0,
  rightHipForward: -20,
  rightHipOut: 0,
  rightHipTwist: 0,
  leftKneeBend: 18,
  rightKneeBend: 36,
};

function createPoseAdjustments(
  value: Partial<DirectorPoseAdjustments>,
): DirectorPoseAdjustments {
  return { ...DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS, ...value };
}

const DIRECTOR_POSE_ADJUSTMENT_PRESETS: Record<
  DirectorPosePreset,
  DirectorPoseAdjustments
> = {
  standing: DIRECTOR_NEUTRAL_POSE_ADJUSTMENTS,
  "t-pose": DIRECTOR_T_POSE_ADJUSTMENTS,
  walking: DIRECTOR_WALKING_POSE_ADJUSTMENTS,
  running: DIRECTOR_RUNNING_POSE_ADJUSTMENTS,
  sitting: createPoseAdjustments({
    bodyPitch: -5,
    torsoPitch: 5,
    headNod: -5,
    leftShoulderOut: 8,
    leftShoulderTwist: 6,
    rightShoulderOut: 15,
    rightShoulderTwist: 16,
    leftElbowBend: 80,
    rightElbowBend: 80,
    leftHipForward: 90,
    leftHipOut: 5,
    rightHipForward: 90,
    rightHipOut: 5,
    leftKneeBend: 90,
    rightKneeBend: 90,
  }),
  crouching: createPoseAdjustments({
    bodyPitch: -3,
    torsoPitch: -45,
    headNod: -15,
    leftShoulderForward: 39,
    leftShoulderOut: 8,
    leftShoulderTwist: 26,
    rightShoulderForward: 20,
    rightShoulderOut: 15,
    rightShoulderTwist: 30,
    leftElbowBend: 87,
    rightElbowBend: 100,
    leftHipForward: 100,
    leftHipOut: 15,
    leftHipTwist: 16,
    rightHipForward: 90,
    rightHipOut: 15,
    rightHipTwist: 16,
    leftKneeBend: 104,
    rightKneeBend: 97,
  }),
  "kneeling-one": createPoseAdjustments({
    bodyPitch: -11,
    torsoPitch: 21,
    headNod: -5,
    leftShoulderForward: 41,
    leftShoulderOut: -4,
    leftShoulderTwist: -24,
    rightShoulderOut: 16,
    leftElbowBend: 71,
    rightElbowBend: 16,
    leftHipForward: 90,
    leftHipTwist: 4,
    rightHipForward: 27,
    leftKneeBend: 74,
    rightKneeBend: 89,
  }),
  "kneeling-both": createPoseAdjustments({
    bodyPitch: 8,
    torsoPitch: 6,
    headNod: -5,
    leftShoulderForward: -5,
    leftShoulderOut: 7,
    rightShoulderForward: -5,
    rightShoulderOut: 10,
    leftElbowBend: 15,
    rightElbowBend: 15,
    leftHipForward: -10,
    rightHipForward: -9,
    leftKneeBend: 108,
    rightKneeBend: 104,
  }),
  "hands-on-hips": createPoseAdjustments({
    headNod: -5,
    leftShoulderForward: -13.8,
    leftShoulderOut: 25.9,
    leftShoulderTwist: -30,
    rightShoulderForward: -20.8,
    rightShoulderOut: 15.6,
    rightShoulderTwist: -16.2,
    leftElbowBend: 80,
    rightElbowBend: 80,
    leftHipOut: 10,
    rightHipOut: 10,
  }),
  leaning: createPoseAdjustments({
    bodyRoll: -5,
    torsoPitch: -3,
    torsoTwist: 5,
    torsoRoll: -5,
    headNod: -10,
    headTurn: 10,
    headTilt: -5,
    leftShoulderForward: -5,
    leftShoulderOut: 13,
    rightShoulderForward: -10,
    rightShoulderOut: 16,
    leftElbowBend: 15,
    rightElbowBend: 20,
    leftHipOut: 5,
    rightHipForward: 20,
    rightHipTwist: 10,
    rightKneeBend: 40,
  }),
  bowing: createPoseAdjustments({
    torsoPitch: -45,
    headNod: 20,
    leftShoulderForward: 13,
    leftShoulderOut: -7,
    rightShoulderForward: 3,
    rightShoulderOut: -5,
    rightShoulderTwist: 10,
    leftElbowBend: 5,
    rightElbowBend: 5,
  }),
  thinking: createPoseAdjustments({
    torsoPitch: 5,
    torsoTwist: -5,
    headNod: -18.5,
    headTurn: -10,
    headTilt: -6.2,
    leftShoulderForward: 5,
    leftShoulderOut: 9.2,
    leftShoulderTwist: -2.3,
    rightShoulderForward: 86.5,
    rightShoulderOut: 9.2,
    rightShoulderTwist: 18.5,
    leftElbowBend: 40.4,
    rightElbowBend: 115.4,
  }),
  fighting: createPoseAdjustments({
    bodyPitch: 5,
    bodyTurn: 15,
    torsoPitch: 8,
    torsoTwist: 10,
    headNod: -5,
    headTurn: -15,
    leftShoulderForward: 60,
    leftShoulderOut: 30,
    rightShoulderForward: 40,
    rightShoulderOut: 25,
    leftElbowBend: 110,
    rightElbowBend: 100,
    leftHipForward: 10,
    leftHipOut: 15,
    leftHipTwist: 10,
    rightHipForward: -5,
    rightHipOut: 15,
    rightHipTwist: -10,
    leftKneeBend: 25,
    rightKneeBend: 30,
  }),
  kicking: createPoseAdjustments({
    bodyPitch: -4,
    bodyTurn: -7,
    bodyRoll: -1,
    torsoPitch: -5,
    torsoTwist: -10,
    torsoRoll: 5,
    headNod: 5,
    headTurn: -10,
    leftShoulderForward: -20,
    leftShoulderOut: 30,
    rightShoulderForward: 20,
    rightShoulderOut: 25,
    leftElbowBend: 40,
    rightElbowBend: 35,
    leftHipForward: -10,
    rightHipForward: 80,
    leftKneeBend: 10,
    rightKneeBend: 20,
  }),
  throwing: createPoseAdjustments({
    bodyPitch: 5,
    bodyTurn: -2,
    torsoPitch: 4,
    torsoTwist: 15,
    torsoRoll: -5,
    headNod: -5,
    headTurn: -15,
    leftShoulderForward: 7,
    leftShoulderOut: 17,
    rightShoulderForward: 77,
    rightShoulderTwist: 50,
    leftElbowBend: 88,
    rightElbowBend: 96,
    leftHipForward: 15,
    leftHipOut: 5,
    rightHipForward: -10,
    rightHipOut: 5,
    leftKneeBend: 26,
    rightKneeBend: 36,
  }),
  pushing: createPoseAdjustments({
    bodyPitch: -1,
    torsoPitch: 19,
    headNod: -5,
    leftShoulderForward: 100,
    leftShoulderOut: 6,
    leftShoulderTwist: 5,
    rightShoulderForward: 101,
    rightShoulderOut: 11,
    leftElbowBend: 14,
    leftHipForward: 41,
    rightHipForward: -15,
    leftKneeBend: 35,
    rightKneeBend: 10,
  }),
  waving: createPoseAdjustments({
    torsoPitch: 2,
    torsoTwist: -10,
    headNod: -5,
    headTurn: 15,
    headTilt: 5,
    leftShoulderOut: 6,
    rightShoulderForward: 62,
    rightShoulderOut: -10,
    rightShoulderTwist: 20,
    leftElbowBend: 62,
    rightElbowBend: 94,
  }),
  stretching: createPoseAdjustments({
    bodyPitch: -5,
    torsoPitch: -16,
    torsoRoll: 3,
    headNod: -25,
    leftShoulderForward: 115,
    leftShoulderOut: -10,
    leftShoulderTwist: 10,
    rightShoulderForward: 133,
    rightShoulderOut: -10,
    rightShoulderTwist: -10,
    leftElbowBend: 59,
    rightElbowBend: 53,
    leftHipOut: 10,
    rightHipOut: 10,
  }),
  "arms-crossed": createPoseAdjustments({
    torsoTwist: 2,
    headNod: -8,
    leftShoulderForward: 7,
    leftShoulderOut: 22,
    leftShoulderTwist: 17,
    rightShoulderForward: 8,
    rightShoulderOut: 22,
    rightShoulderTwist: 39,
    leftElbowBend: 107,
    rightElbowBend: 107,
    leftHipOut: 5,
    rightHipOut: 5,
  }),
  phone: createPoseAdjustments({
    torsoPitch: 5,
    headNod: 17,
    leftShoulderForward: 55,
    leftShoulderOut: -10,
    leftShoulderTwist: -4,
    rightShoulderForward: 24,
    rightShoulderOut: -10,
    rightShoulderTwist: -13,
    leftElbowBend: 89,
    rightElbowBend: 43,
    leftHipOut: 5,
    rightHipOut: 5,
  }),
};

export function getDirectorPoseAdjustments(
  posePreset: DirectorPosePreset,
  value?: Partial<DirectorPoseAdjustments>,
): DirectorPoseAdjustments {
  const fallback = DIRECTOR_POSE_ADJUSTMENT_PRESETS[posePreset];
  const source = value ?? {};
  return {
    bodyPitch: clampNumber(source.bodyPitch, -90, 90, fallback.bodyPitch),
    bodyTurn: clampNumber(source.bodyTurn, -90, 90, fallback.bodyTurn),
    bodyRoll: clampNumber(source.bodyRoll, -45, 45, fallback.bodyRoll),
    torsoPitch: clampNumber(source.torsoPitch, -45, 45, fallback.torsoPitch),
    torsoTwist: clampNumber(
      source.torsoTwist,
      -45,
      45,
      fallback.torsoTwist,
    ),
    torsoRoll: clampNumber(source.torsoRoll, -30, 30, fallback.torsoRoll),
    headNod: clampNumber(source.headNod, -60, 60, fallback.headNod),
    headTurn: clampNumber(source.headTurn, -90, 90, fallback.headTurn),
    headTilt: clampNumber(source.headTilt, -30, 30, fallback.headTilt),
    leftShoulderForward: clampNumber(
      source.leftShoulderForward,
      -90,
      180,
      fallback.leftShoulderForward,
    ),
    leftShoulderOut: clampNumber(
      source.leftShoulderOut,
      -10,
      90,
      fallback.leftShoulderOut,
    ),
    leftShoulderTwist: clampNumber(
      source.leftShoulderTwist,
      -90,
      90,
      fallback.leftShoulderTwist,
    ),
    rightShoulderForward: clampNumber(
      source.rightShoulderForward,
      -90,
      180,
      fallback.rightShoulderForward,
    ),
    rightShoulderOut: clampNumber(
      source.rightShoulderOut,
      -10,
      90,
      fallback.rightShoulderOut,
    ),
    rightShoulderTwist: clampNumber(
      source.rightShoulderTwist,
      -90,
      90,
      fallback.rightShoulderTwist,
    ),
    leftElbowBend: clampNumber(
      source.leftElbowBend,
      0,
      150,
      fallback.leftElbowBend,
    ),
    rightElbowBend: clampNumber(
      source.rightElbowBend,
      0,
      150,
      fallback.rightElbowBend,
    ),
    leftHipForward: clampNumber(
      source.leftHipForward,
      -90,
      120,
      fallback.leftHipForward,
    ),
    leftHipOut: clampNumber(source.leftHipOut, -30, 60, fallback.leftHipOut),
    leftHipTwist: clampNumber(
      source.leftHipTwist,
      -45,
      45,
      fallback.leftHipTwist,
    ),
    rightHipForward: clampNumber(
      source.rightHipForward,
      -90,
      120,
      fallback.rightHipForward,
    ),
    rightHipOut: clampNumber(source.rightHipOut, -30, 60, fallback.rightHipOut),
    rightHipTwist: clampNumber(
      source.rightHipTwist,
      -45,
      45,
      fallback.rightHipTwist,
    ),
    leftKneeBend: clampNumber(
      source.leftKneeBend,
      0,
      150,
      fallback.leftKneeBend,
    ),
    rightKneeBend: clampNumber(
      source.rightKneeBend,
      0,
      150,
      fallback.rightKneeBend,
    ),
  };
}

const DIRECTOR_DEFAULT_CAMERA_POSITION: [number, number, number] = [0, 2.2, 10];
const DIRECTOR_DEFAULT_CAMERA_ROTATION: [number, number, number] = [
  (5.71 * Math.PI) / 180,
  Math.PI,
  0,
];
const DIRECTOR_DEFAULT_CAMERA_TARGET: [number, number, number] = [0, 1.2, 0];

export function createInitialDirectorStudioState(): DirectorStudioState {
  return {
    objects: [
      {
        id: "director-character-1",
        name: "角色A",
        kind: "character",
        color: "#d2a679",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        uniformScale: 1,
        visible: true,
        characterModel: "adult-male",
        posePreset: "standing",
        poseAdjustments: getDirectorPoseAdjustments("standing"),
        poseJointRotations: {},
      },
      {
        id: "director-cube-1",
        name: "方块A",
        kind: "cube",
        color: "#5c718c",
        position: [2.2, 0.55, -0.8],
        rotation: [0, 0.28, 0],
        scale: [1, 1, 1],
        uniformScale: 1,
        visible: true,
      },
      {
        id: "director-camera-1",
        name: "机位A",
        kind: "camera",
        color: "#d4b66f",
        position: DIRECTOR_DEFAULT_CAMERA_POSITION,
        rotation: DIRECTOR_DEFAULT_CAMERA_ROTATION,
        scale: [1, 1, 1],
        uniformScale: 1,
        visible: true,
        cameraFov: 50,
        cameraTargetObjectId: null,
        cameraTargetPosition: DIRECTOR_DEFAULT_CAMERA_TARGET,
      },
    ],
    cameraSetupInitialized: true,
    scene: {
      viewScaleInitialized: true,
      scale: DIRECTOR_DEFAULT_SCENE_SCALE,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      skyColor: "#1d1d1d",
      panoramaRotation: 0,
      panoramaRadius: 40,
      showCharacterLabels: true,
      snapToGrid: false,
      snapToGround: true,
      groundVisible: true,
      groundOpacity: 0.4,
    },
    camera: {
      position: DIRECTOR_DEFAULT_CAMERA_POSITION,
      fov: 50,
      targetObjectId: null,
      targetPosition: DIRECTOR_DEFAULT_CAMERA_TARGET,
    },
    captureRatio: "16:9",
  };
}

export function readDirectorStudioState(value: unknown): DirectorStudioState {
  const fallback = createInitialDirectorStudioState();
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Partial<DirectorStudioState>;
  const candidateObjects = Array.isArray(candidate.objects)
    ? candidate.objects.filter(isDirectorObject)
    : fallback.objects;
  const normalizedObjects = (
    candidateObjects.length > 0 ? candidateObjects : fallback.objects
  ).map((object) => ({
    ...object,
    uniformScale: clampNumber(object.uniformScale, 0.1, 5, 1),
    scale: object.scale.map((value) =>
      clampNumber(value, 0.1, 10, 1),
    ) as [number, number, number],
    position: clampDirectorPosition(
      object.position,
      getDirectorPositionMode(object.kind),
    ),
    color: isHexColor(object.color) ? object.color : "#ffffff",
    ...(object.kind === "character"
      ? {
          characterModel: normalizeDirectorCharacterModel(object.characterModel),
          color:
            object.characterModel === "muscular" &&
            isHexColor(object.color) &&
            ["#2f6fb5", "#e7aa3a"].includes(object.color.toLowerCase())
              ? "#ffffff"
              : isHexColor(object.color)
                ? object.color
                : "#ffffff",
          posePreset: isDirectorPosePreset(object.posePreset)
            ? object.posePreset
            : "standing",
          poseAdjustments: getDirectorPoseAdjustments(
            isDirectorPosePreset(object.posePreset)
              ? object.posePreset
              : "standing",
            object.poseAdjustments,
          ),
          poseJointRotations: readDirectorPoseJointRotations(
            object.poseJointRotations,
          ),
        }
      : {}),
    ...(object.kind === "camera"
      ? {
          cameraTargetObjectId:
            typeof object.cameraTargetObjectId === "string" ||
            object.cameraTargetObjectId === null
              ? object.cameraTargetObjectId
              : undefined,
          cameraTargetPosition: isVector3(object.cameraTargetPosition)
            ? clampDirectorPosition(object.cameraTargetPosition, "target")
            : undefined,
        }
      : {}),
  }));
  const objectIds = new Set(normalizedObjects.map((object) => object.id));
  const objects = normalizedObjects.map((object) =>
    object.kind === "camera" &&
    object.cameraTargetObjectId &&
    !objectIds.has(object.cameraTargetObjectId)
      ? { ...object, cameraTargetObjectId: null }
      : object,
  );
  const defaultCamera = fallback.objects.find(
    (object) => object.kind === "camera",
  );
  const objectsWithDefaultCamera =
    candidate.cameraSetupInitialized === true ||
    objects.some((object) => object.kind === "camera") ||
    !defaultCamera
      ? objects
      : [...objects, defaultCamera];
  const camera = candidate.camera;
  const scene = candidate.scene;

  return {
    objects: objectsWithDefaultCamera,
    cameraSetupInitialized: true,
    scene: {
      // 旧版本把 scale 施加在场景实体上；新版将它作为编辑视图缩放。
      // 不沿用旧数值，避免升级后把既有构图缩得过远或过近。
      viewScaleInitialized: true,
      scale:
        scene?.viewScaleInitialized === true
          ? clampNumber(scene.scale, 0.2, 30, fallback.scene.scale)
          : fallback.scene.scale,
      position: isVector3(scene?.position)
        ? scene.position
        : fallback.scene.position,
      rotation: isVector3(scene?.rotation)
        ? scene.rotation
        : fallback.scene.rotation,
      skyColor: isHexColor(scene?.skyColor)
        ? scene.skyColor
        : fallback.scene.skyColor,
      panoramaRotation: clampNumber(
        scene?.panoramaRotation,
        -180,
        180,
        fallback.scene.panoramaRotation,
      ),
      panoramaRadius: clampNumber(
        scene?.panoramaRadius,
        10,
        120,
        fallback.scene.panoramaRadius,
      ),
      showCharacterLabels:
        typeof scene?.showCharacterLabels === "boolean"
          ? scene.showCharacterLabels
          : fallback.scene.showCharacterLabels,
      snapToGrid:
        typeof scene?.snapToGrid === "boolean"
          ? scene.snapToGrid
          : fallback.scene.snapToGrid,
      snapToGround:
        typeof scene?.snapToGround === "boolean"
          ? scene.snapToGround
          : fallback.scene.snapToGround,
      groundVisible:
        typeof scene?.groundVisible === "boolean"
          ? scene.groundVisible
          : fallback.scene.groundVisible,
      groundOpacity: clampNumber(
        scene?.groundOpacity,
        0,
        1,
        fallback.scene.groundOpacity,
      ),
    },
    camera: {
      position: isVector3(camera?.position)
        ? clampDirectorPosition(camera.position, "camera")
        : fallback.camera.position,
      fov:
        typeof camera?.fov === "number" && Number.isFinite(camera.fov)
          ? Math.min(100, Math.max(20, camera.fov))
          : fallback.camera.fov,
      targetObjectId:
        typeof camera?.targetObjectId === "string" &&
        objectIds.has(camera.targetObjectId)
          ? camera.targetObjectId
          : null,
      targetPosition: isVector3(camera?.targetPosition)
        ? clampDirectorPosition(camera.targetPosition, "target")
        : fallback.camera.targetPosition,
    },
    captureRatio: DIRECTOR_CAPTURE_RATIOS.some(
      (ratio) => ratio.value === candidate.captureRatio,
    )
      ? (candidate.captureRatio as DirectorCaptureRatio)
      : fallback.captureRatio,
  };
}

export function createDirectorObject(
  kind: DirectorObjectKind,
  namePrefix = directorObjectLabels[kind],
  characterModel: DirectorCharacterModel = "adult-male",
  usedNames: string[] = [],
): DirectorObject {
  const id = `director-${kind}-${crypto.randomUUID()}`;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let letterIndex = 0;
  while (letterIndex < letters.length) {
    const candidate = `${namePrefix}${letters[letterIndex]}`;
    if (!usedNames.includes(candidate)) break;
    letterIndex += 1;
  }
  const name =
    letterIndex < letters.length
      ? `${namePrefix}${letters[letterIndex]}`
      : `${namePrefix}${usedNames.length + 1}`;
  const spread = (letterIndex % 4) + 1;
  const base = {
    id,
    name,
    position: [spread * 0.7 - 1.4, 0, spread * 0.45 + 0.8] as [
      number,
      number,
      number,
    ],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    uniformScale: 1,
    visible: true,
  };

  if (kind === "character") {
    return {
      ...base,
      kind,
      color: characterModel === "muscular" ? "#ffffff" : "#d2a679",
      characterModel,
      posePreset: "standing",
      poseAdjustments: getDirectorPoseAdjustments("standing"),
      poseJointRotations: {},
    };
  }
  if (kind === "sphere") return { ...base, kind, color: "#7b8fb8" };
  if (kind === "crowd") return { ...base, kind, color: "#9a7cb7" };
  if (kind === "camera") {
    return {
      ...base,
      kind,
      color: "#d4b66f",
      cameraFov: 50,
      cameraTargetObjectId: null,
      cameraTargetPosition: DIRECTOR_DEFAULT_CAMERA_TARGET,
    };
  }
  return { ...base, kind, color: "#60758c" };
}

export function clampDirectorPosition(
  position: [number, number, number],
  mode: "object" | "character" | "camera" | "target",
): [number, number, number] {
  const horizontalLimit =
    mode === "camera"
      ? DIRECTOR_STAGE.cameraHorizontalLimit
      : mode === "target"
        ? DIRECTOR_STAGE.halfSize
        : DIRECTOR_STAGE.objectHorizontalLimit;
  const minHeight =
    mode === "camera"
      ? DIRECTOR_STAGE.cameraMinHeight
      : mode === "character"
        ? DIRECTOR_STAGE.characterMinHeight
        : mode === "target"
          ? DIRECTOR_STAGE.targetMinHeight
          : DIRECTOR_STAGE.objectMinHeight;
  const maxHeight =
    mode === "camera"
      ? DIRECTOR_STAGE.cameraMaxHeight
      : mode === "target"
        ? DIRECTOR_STAGE.targetMaxHeight
        : DIRECTOR_STAGE.objectMaxHeight;

  return [
    clampNumber(position[0], -horizontalLimit, horizontalLimit, 0),
    clampNumber(position[1], minHeight, maxHeight, minHeight),
    clampNumber(position[2], -horizontalLimit, horizontalLimit, 0),
  ];
}

export function getDirectorPositionMode(
  kind: DirectorObjectKind,
): "object" | "character" | "camera" {
  if (kind === "camera") return "camera";
  if (kind === "character" || kind === "crowd") return "character";
  return "object";
}

function isDirectorObject(value: unknown): value is DirectorObject {
  if (!value || typeof value !== "object") return false;
  const object = value as Partial<DirectorObject>;
  return (
    typeof object.id === "string" &&
    typeof object.name === "string" &&
    typeof object.kind === "string" &&
    ["character", "cube", "sphere", "crowd", "camera"].includes(object.kind) &&
    typeof object.color === "string" &&
    isVector3(object.position) &&
    isVector3(object.rotation) &&
    isVector3(object.scale) &&
    (object.uniformScale === undefined ||
      (typeof object.uniformScale === "number" &&
        Number.isFinite(object.uniformScale) &&
        object.uniformScale >= 0.1 &&
        object.uniformScale <= 5)) &&
    typeof object.visible === "boolean" &&
    (object.characterModel === undefined ||
      typeof object.characterModel === "string") &&
    (object.posePreset === undefined ||
      isDirectorPosePreset(object.posePreset)) &&
    (object.poseAdjustments === undefined ||
      (typeof object.poseAdjustments === "object" &&
        object.poseAdjustments !== null)) &&
    (object.poseJointRotations === undefined ||
      (typeof object.poseJointRotations === "object" &&
        object.poseJointRotations !== null)) &&
    (object.cameraFov === undefined ||
      (typeof object.cameraFov === "number" &&
        Number.isFinite(object.cameraFov) &&
        object.cameraFov >= 20 &&
        object.cameraFov <= 100))
  );
}

function isDirectorCharacterModel(
  value: unknown,
): value is DirectorCharacterModel {
  return DIRECTOR_CHARACTER_MODEL_VALUES.includes(
    value as DirectorCharacterModel,
  );
}

function normalizeDirectorCharacterModel(
  value: unknown,
): DirectorCharacterModel {
  if (value === "child") return "teenager";
  return isDirectorCharacterModel(value) ? value : "adult-male";
}

function isDirectorPosePreset(value: unknown): value is DirectorPosePreset {
  return DIRECTOR_POSE_PRESET_VALUES.includes(
    value as DirectorPosePreset,
  );
}

const DIRECTOR_POSE_JOINT_IDS: DirectorPoseJointId[] = [
  "head",
  "chest",
  "pelvis",
  "root",
  "leftShoulder",
  "leftElbow",
  "leftHand",
  "rightShoulder",
  "rightElbow",
  "rightHand",
  "leftHip",
  "leftKnee",
  "leftAnkle",
  "rightHip",
  "rightKnee",
  "rightAnkle",
];

function readDirectorPoseJointRotations(
  value: unknown,
): DirectorPoseJointRotations {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const rotations: DirectorPoseJointRotations = {};

  DIRECTOR_POSE_JOINT_IDS.forEach((jointId) => {
    const quaternion = source[jointId];
    if (
      !Array.isArray(quaternion) ||
      quaternion.length !== 4 ||
      !quaternion.every(
        (entry) => typeof entry === "number" && Number.isFinite(entry),
      )
    ) {
      return;
    }
    const length = Math.hypot(...quaternion);
    if (length < 0.000001) return;
    rotations[jointId] = quaternion.map((entry) =>
      Number((entry / length).toFixed(6)),
    ) as [number, number, number, number];
  });

  return rotations;
}

function isVector3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
