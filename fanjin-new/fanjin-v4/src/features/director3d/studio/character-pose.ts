import { Euler, Quaternion, Vector3, type Object3D } from "three";
import type {
  DirectorPoseAdjustments,
  DirectorPoseJointId,
  DirectorPoseJointRotations,
  DirectorPosePreset,
} from "./types";

export type CharacterBindPose = ReadonlyMap<string, Quaternion>;

export type CharacterPoseJointId = DirectorPoseJointId;

type CharacterRigProfile =
  | "director-41"
  | "director-41-custom"
  | "mixamo"
  | "mpfb-game-engine"
  | "quaternius-ual";

const MIXAMO_BONE_ALIASES: Readonly<Record<string, string>> = {
  Head: "Head",
  Spine02: "Spine2",
  Spine01: "Spine1",
  Hip: "Hips",
  Root: "root",
  L_Clavicle: "LeftShoulder",
  L_Upperarm: "LeftArm",
  L_Forearm: "LeftForeArm",
  L_Hand: "LeftHand",
  L_Thigh: "LeftUpLeg",
  L_Calf: "LeftLeg",
  L_Foot: "LeftFoot",
  R_Clavicle: "RightShoulder",
  R_Upperarm: "RightArm",
  R_Forearm: "RightForeArm",
  R_Hand: "RightHand",
  R_Thigh: "RightUpLeg",
  R_Calf: "RightLeg",
  R_Foot: "RightFoot",
};

const MPFB_BONE_ALIASES: Readonly<Record<string, string>> = {
  Head: "head",
  Spine02: "spine_03",
  Spine01: "spine_02",
  Hip: "pelvis",
  Root: "Root",
  L_Clavicle: "clavicle_l",
  L_Upperarm: "upperarm_l",
  L_Forearm: "lowerarm_l",
  L_Hand: "hand_l",
  L_Thigh: "thigh_l",
  L_Calf: "calf_l",
  L_Foot: "foot_l",
  R_Clavicle: "clavicle_r",
  R_Upperarm: "upperarm_r",
  R_Forearm: "lowerarm_r",
  R_Hand: "hand_r",
  R_Thigh: "thigh_r",
  R_Calf: "calf_r",
  R_Foot: "foot_r",
};

const MPFB_T_POSE_REFERENCE = {
  leftShoulderForward: 16,
  leftShoulderOut: 60,
  leftShoulderTwist: 40,
  rightShoulderForward: 22,
  rightShoulderOut: 54,
  rightShoulderTwist: 41,
} as const;

/** Creator-authored Idle_Loop frame zero, stored as Blender (x, y, z, w)
 * quaternions after converting from Blender's printed (w, x, y, z) order.
 * Their inverse restores the original Quaternius T-pose from the baked idle
 * bind pose without guessing at the mannequin's bone roll. */
const QUATERNIUS_IDLE_ARM_ROTATIONS = {
  L: {
    clavicle: [-0.021486804, -0.00570102, -0.054748848, 0.998252511],
    upperarm: [-0.062197968, 0.000000052, -0.572302818, 0.81768018],
    forearm: [0.263786137, 0.042812452, -0.00563256, 0.963614106],
    hand: [0.114572912, 0.006597245, -0.025618475, 0.993062496],
  },
  R: {
    clavicle: [-0.021649674, 0.00547953, -0.049336776, 0.998532355],
    upperarm: [-0.089054577, 0.000000007, 0.558573365, 0.824660718],
    forearm: [0.351480514, -0.152625561, 0.064309895, 0.921428919],
    hand: [0.125256762, 0.002530071, 0.044802155, 0.991108835],
  },
} as const;

export const CHARACTER_POSE_JOINTS: ReadonlyArray<{
  id: CharacterPoseJointId;
  boneName: string;
  label: string;
}> = [
  { id: "head", boneName: "Head", label: "头部" },
  { id: "chest", boneName: "Spine02", label: "胸腔" },
  { id: "pelvis", boneName: "Hip", label: "身体" },
  { id: "root", boneName: "Root", label: "根节点" },
  { id: "leftShoulder", boneName: "L_Upperarm", label: "左肩" },
  { id: "leftElbow", boneName: "L_Forearm", label: "左肘" },
  { id: "leftHand", boneName: "L_Hand", label: "左手" },
  { id: "rightShoulder", boneName: "R_Upperarm", label: "右肩" },
  { id: "rightElbow", boneName: "R_Forearm", label: "右肘" },
  { id: "rightHand", boneName: "R_Hand", label: "右手" },
  { id: "leftHip", boneName: "L_Thigh", label: "左髋" },
  { id: "leftKnee", boneName: "L_Calf", label: "左膝" },
  { id: "leftAnkle", boneName: "L_Foot", label: "左踝" },
  { id: "rightHip", boneName: "R_Thigh", label: "右髋" },
  { id: "rightKnee", boneName: "R_Calf", label: "右膝" },
  { id: "rightAnkle", boneName: "R_Foot", label: "右踝" },
];

/** Main pose handles shown by the reference editor. Wrist and ankle positions
 * remain in the line rig, but do not render a separate clickable sphere. */
export const CHARACTER_POSE_MARKER_JOINT_IDS: ReadonlySet<CharacterPoseJointId> =
  new Set([
    "head",
    "pelvis",
    "root",
    "leftShoulder",
    "leftElbow",
    "rightShoulder",
    "rightElbow",
    "leftHip",
    "leftKnee",
    "rightHip",
    "rightKnee",
  ]);

export const CHARACTER_POSE_LINKS: ReadonlyArray<
  readonly [CharacterPoseJointId, CharacterPoseJointId]
> = [
  ["head", "pelvis"],
  ["pelvis", "leftShoulder"],
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftHand"],
  ["pelvis", "rightShoulder"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightHand"],
  ["pelvis", "leftHip"],
  ["leftHip", "leftKnee"],
  ["leftKnee", "leftAnkle"],
  ["leftAnkle", "root"],
  ["pelvis", "rightHip"],
  ["rightHip", "rightKnee"],
  ["rightKnee", "rightAnkle"],
  ["rightAnkle", "root"],
];

export function captureCharacterBindPose(model: Object3D): CharacterBindPose {
  const bindPose = new Map<string, Quaternion>();
  model.traverse((child) => {
    if (child.type === "Bone") {
      bindPose.set(child.name, child.quaternion.clone());
    }
  });
  return bindPose;
}

export function applyCharacterPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  posePreset: DirectorPosePreset,
  adjustments: DirectorPoseAdjustments,
  jointRotations: DirectorPoseJointRotations = {},
) {
  const rigProfile = getCharacterRigProfile(model);
  model.traverse((child) => {
    const bindQuaternion = bindPose.get(child.name);
    if (bindQuaternion) child.quaternion.copy(bindQuaternion);
  });
  model.updateMatrixWorld(true);

  const applyPreset = posePreset !== "standing";
  if (
    rigProfile === "mpfb-game-engine" ||
    applyPreset ||
    hasArmAdjustment(adjustments, "L")
  ) {
    applyArmPose(
      model,
      bindPose,
      "L",
      posePreset,
      adjustments,
      rigProfile,
    );
  }
  if (
    rigProfile === "mpfb-game-engine" ||
    applyPreset ||
    hasArmAdjustment(adjustments, "R")
  ) {
    applyArmPose(
      model,
      bindPose,
      "R",
      posePreset,
      adjustments,
      rigProfile,
    );
  }

  const usesLegPreset = posePreset !== "standing";
  if (
    usesLegPreset ||
    hasLegAdjustment(adjustments, "L") ||
    hasLegAdjustment(adjustments, "R")
  ) {
    if (usesLegPreset || hasLegAdjustment(adjustments, "L")) {
      applyLegPose(model, bindPose, "L", posePreset, adjustments, rigProfile);
    }
    if (usesLegPreset || hasLegAdjustment(adjustments, "R")) {
      applyLegPose(model, bindPose, "R", posePreset, adjustments, rigProfile);
    }
  }

  applyCorePose(model, bindPose, adjustments, rigProfile);
  applyCharacterJointRotations(model, jointRotations);
  model.updateMatrixWorld(true);
}

function applyCharacterJointRotations(
  model: Object3D,
  jointRotations: DirectorPoseJointRotations,
) {
  CHARACTER_POSE_JOINTS.forEach(({ id, boneName }) => {
    const value = jointRotations[id];
    const bone = value ? getCharacterBone(model, boneName) : null;
    if (!value || !bone) return;

    bone.quaternion.multiply(new Quaternion(...value).normalize()).normalize();
  });
}

export function getCharacterPoseJointPositions(
  model: Object3D,
): Partial<Record<CharacterPoseJointId, Vector3>> {
  model.updateMatrixWorld(true);
  const rootInverse = model.matrixWorld.clone().invert();
  const positions: Partial<Record<CharacterPoseJointId, Vector3>> = {};

  CHARACTER_POSE_JOINTS.forEach(({ id, boneName }) => {
    const bone = getCharacterBone(model, boneName);
    if (!bone) return;
    positions[id] = bone.getWorldPosition(new Vector3()).applyMatrix4(rootInverse);
  });

  // The imported rig's spine bone origins are authoring pivots rather than the
  // visible anatomical centres used by the pose editor. Derive the torso
  // controls from the limb joints so the overlay remains centred after poses.
  const leftShoulder = positions.leftShoulder;
  const rightShoulder = positions.rightShoulder;
  const leftHip = positions.leftHip;
  const rightHip = positions.rightHip;

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    const shoulderCentre = leftShoulder
      .clone()
      .add(rightShoulder)
      .multiplyScalar(0.5);
    const hipCentre = leftHip.clone().add(rightHip).multiplyScalar(0.5);
    const torsoAxis = shoulderCentre.clone().sub(hipCentre);

    // The single visible torso handle sits above the hip sockets, matching the
    // abdomen-centred controller in the reference editor.
    positions.pelvis = hipCentre.clone().addScaledVector(torsoAxis, 0.2);
    positions.chest = hipCentre.clone().addScaledVector(torsoAxis, 0.62);
    // The upper point sits at the base of the neck, not at the Head pivot.
    positions.head = shoulderCentre.clone().addScaledVector(torsoAxis, 0.22);

    const rigRoot = positions.root;
    if (rigRoot) {
      positions.root = new Vector3(hipCentre.x, rigRoot.y, hipCentre.z);
    } else if (positions.leftAnkle && positions.rightAnkle) {
      positions.root = new Vector3(
        hipCentre.x,
        Math.min(positions.leftAnkle.y, positions.rightAnkle.y),
        hipCentre.z,
      );
    }
  }

  return positions;
}

function applyCorePose(
  model: Object3D,
  bindPose: CharacterBindPose,
  adjustments: DirectorPoseAdjustments,
  rigProfile: CharacterRigProfile,
) {
  if (rigProfile === "mixamo") {
    applyMixamoCorePose(model, bindPose, adjustments);
    return;
  }

  applyBindPoseEuler(
    model,
    bindPose,
    "Head",
    new Euler(
      degreesToRadians(-adjustments.headNod),
      degreesToRadians(-adjustments.headTurn),
      degreesToRadians(-adjustments.headTilt),
      "YXZ",
    ),
  );

  applyBindPoseEuler(
    model,
    bindPose,
    "Spine01",
    new Euler(
      degreesToRadians(-adjustments.torsoPitch),
      degreesToRadians(-adjustments.torsoTwist),
      degreesToRadians(-adjustments.torsoRoll),
      "YXZ",
    ),
  );

  applyBindPoseEuler(
    model,
    bindPose,
    "Hip",
    new Euler(
      degreesToRadians(-adjustments.bodyPitch),
      degreesToRadians(-adjustments.bodyTurn),
      degreesToRadians(-adjustments.bodyRoll),
      "YXZ",
    ),
  );
}

function hasArmAdjustment(
  adjustments: DirectorPoseAdjustments,
  side: "L" | "R",
) {
  return side === "L"
    ? adjustments.leftShoulderForward !== 0 ||
        adjustments.leftShoulderOut !== 0 ||
        adjustments.leftShoulderTwist !== 0 ||
        adjustments.leftElbowBend !== 0
    : adjustments.rightShoulderForward !== 0 ||
        adjustments.rightShoulderOut !== 0 ||
        adjustments.rightShoulderTwist !== 0 ||
        adjustments.rightElbowBend !== 0;
}

function hasLegAdjustment(
  adjustments: DirectorPoseAdjustments,
  side: "L" | "R",
) {
  return side === "L"
    ? adjustments.leftHipForward !== 0 ||
        adjustments.leftHipOut !== 0 ||
        adjustments.leftHipTwist !== 0 ||
        adjustments.leftKneeBend !== 0
    : adjustments.rightHipForward !== 0 ||
        adjustments.rightHipOut !== 0 ||
        adjustments.rightHipTwist !== 0 ||
        adjustments.rightKneeBend !== 0;
}

function applyArmPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  side: "L" | "R",
  posePreset: DirectorPosePreset,
  adjustments: DirectorPoseAdjustments,
  rigProfile: CharacterRigProfile,
) {
  const left = side === "L";
  const forward = left
    ? adjustments.leftShoulderForward
    : adjustments.rightShoulderForward;
  const outward = left
    ? adjustments.leftShoulderOut
    : adjustments.rightShoulderOut;
  const twist = left
    ? adjustments.leftShoulderTwist
    : adjustments.rightShoulderTwist;
  const elbow = left ? adjustments.leftElbowBend : adjustments.rightElbowBend;
  const upperarmName = `${side}_Upperarm`;
  const forearmName = `${side}_Forearm`;

  if (rigProfile === "mixamo") {
    applyMixamoArmPose(
      model,
      bindPose,
      side,
      posePreset,
      forward,
      outward,
      twist,
      elbow,
    );
    return;
  }
  if (rigProfile === "mpfb-game-engine") {
    applyMpfbArmPose(
      model,
      bindPose,
      side,
      posePreset,
      forward,
      outward,
      twist,
      elbow,
    );
    return;
  }
  if (rigProfile === "quaternius-ual" && posePreset === "t-pose") {
    applyQuaterniusTPose(
      model,
      bindPose,
      side,
      forward,
      outward,
      twist,
      elbow,
    );
    return;
  }

  // The source GLB is authored with mirrored local bone frames. Preserve the
  // bind quaternion and apply the editor angles in that local frame so equal
  // left/right values retain the rig's native mirror behaviour and bone roll.
  applyBindPoseEuler(
    model,
    bindPose,
    upperarmName,
    new Euler(
      degreesToRadians(forward),
      degreesToRadians(left ? -twist : twist),
      degreesToRadians(left ? outward : -outward),
      "ZXY",
    ),
  );
  if (rigProfile === "director-41-custom" && posePreset === "t-pose") {
    levelCharacterUpperarm(model, side);
  }
  applyBindPoseEuler(
    model,
    bindPose,
    forearmName,
    new Euler(degreesToRadians(elbow), 0, 0, "XYZ"),
  );
  if (rigProfile === "director-41-custom" && posePreset === "t-pose") {
    straightenCharacterElbow(model, side);
  }
}

function applyMixamoArmPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  side: "L" | "R",
  posePreset: DirectorPosePreset,
  forward: number,
  outward: number,
  twist: number,
  elbow: number,
) {
  const left = side === "L";
  const referenceForward = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderForward
    : MPFB_T_POSE_REFERENCE.rightShoulderForward;
  const referenceOut = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderOut
    : MPFB_T_POSE_REFERENCE.rightShoulderOut;
  const referenceTwist = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderTwist
    : MPFB_T_POSE_REFERENCE.rightShoulderTwist;
  const calibratedForward =
    posePreset === "t-pose" ? forward - referenceForward : forward;
  const calibratedOut =
    posePreset === "t-pose" ? outward - referenceOut : outward;
  const calibratedTwist =
    posePreset === "t-pose" ? twist - referenceTwist : twist;
  const forwardRotation = new Quaternion().setFromAxisAngle(
    new Vector3(1, 0, 0),
    degreesToRadians(-calibratedForward),
  );
  const outwardRotation = new Quaternion().setFromAxisAngle(
    new Vector3(0, 0, 1),
    degreesToRadians(left ? calibratedOut : -calibratedOut),
  );
  const localTwist = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    degreesToRadians(left ? -calibratedTwist : calibratedTwist),
  );

  applyModelSpaceBindPoseRotation(
    model,
    bindPose,
    `${side}_Upperarm`,
    outwardRotation.multiply(forwardRotation),
    localTwist,
  );
  applyBindPoseEuler(
    model,
    bindPose,
    `${side}_Forearm`,
    new Euler(0, 0, degreesToRadians(left ? elbow : -elbow), "XYZ"),
  );

  if (posePreset === "t-pose") {
    levelCharacterUpperarm(model, side);
    straightenCharacterElbow(model, side);
  }
}

function levelCharacterUpperarm(model: Object3D, side: "L" | "R") {
  const shoulder = getCharacterBone(model, `${side}_Upperarm`);
  const forearm = getCharacterBone(model, `${side}_Forearm`);
  if (!shoulder || !forearm || !shoulder.parent) return;

  model.updateMatrixWorld(true);
  const shoulderPosition = shoulder.getWorldPosition(new Vector3());
  const elbowPosition = forearm.getWorldPosition(new Vector3());
  const currentDirection = elbowPosition.clone().sub(shoulderPosition).normalize();
  const desiredDirection = new Vector3(
    currentDirection.x,
    0,
    currentDirection.z,
  ).normalize();
  if (desiredDirection.lengthSq() === 0) return;

  const worldCorrection = new Quaternion().setFromUnitVectors(
    currentDirection,
    desiredDirection,
  );
  const desiredWorldQuaternion = worldCorrection.multiply(
    shoulder.getWorldQuaternion(new Quaternion()),
  );
  const parentWorldInverse = shoulder.parent
    .getWorldQuaternion(new Quaternion())
    .invert();
  shoulder.quaternion
    .copy(parentWorldInverse.multiply(desiredWorldQuaternion))
    .normalize();
  model.updateMatrixWorld(true);
}

function straightenCharacterElbow(model: Object3D, side: "L" | "R") {
  const shoulder = getCharacterBone(model, `${side}_Upperarm`);
  const forearm = getCharacterBone(model, `${side}_Forearm`);
  const hand = getCharacterBone(model, `${side}_Hand`);
  if (!shoulder || !forearm || !hand || !forearm.parent) return;

  model.updateMatrixWorld(true);
  const shoulderPosition = shoulder.getWorldPosition(new Vector3());
  const elbowPosition = forearm.getWorldPosition(new Vector3());
  const handPosition = hand.getWorldPosition(new Vector3());
  const currentDirection = handPosition.clone().sub(elbowPosition).normalize();
  const desiredDirection = elbowPosition.clone().sub(shoulderPosition).normalize();
  if (currentDirection.lengthSq() === 0 || desiredDirection.lengthSq() === 0) {
    return;
  }

  const worldCorrection = new Quaternion().setFromUnitVectors(
    currentDirection,
    desiredDirection,
  );
  const desiredWorldQuaternion = worldCorrection.multiply(
    forearm.getWorldQuaternion(new Quaternion()),
  );
  const parentWorldInverse = forearm.parent
    .getWorldQuaternion(new Quaternion())
    .invert();
  forearm.quaternion
    .copy(parentWorldInverse.multiply(desiredWorldQuaternion))
    .normalize();
  model.updateMatrixWorld(true);
}

function applyQuaterniusTPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  side: "L" | "R",
  forward: number,
  outward: number,
  twist: number,
  elbow: number,
) {
  const left = side === "L";
  const sideSuffix = side === "L" ? "l" : "r";
  const rotations = QUATERNIUS_IDLE_ARM_ROTATIONS[side];
  (
    [
      [`clavicle_${sideSuffix}`, rotations.clavicle],
      [`upperarm_${sideSuffix}`, rotations.upperarm],
      [`lowerarm_${sideSuffix}`, rotations.forearm],
      [`hand_${sideSuffix}`, rotations.hand],
    ] as const
  ).forEach(([boneName, idleRotation]) => {
    applyBindPoseQuaternion(
      model,
      bindPose,
      boneName,
      new Quaternion(...idleRotation).invert(),
    );
  });

  const referenceForward = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderForward
    : MPFB_T_POSE_REFERENCE.rightShoulderForward;
  const referenceOut = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderOut
    : MPFB_T_POSE_REFERENCE.rightShoulderOut;
  const referenceTwist = left
    ? MPFB_T_POSE_REFERENCE.leftShoulderTwist
    : MPFB_T_POSE_REFERENCE.rightShoulderTwist;
  multiplyCharacterBoneQuaternion(
    model,
    `upperarm_${sideSuffix}`,
    new Quaternion().setFromEuler(
      new Euler(
        degreesToRadians(forward - referenceForward),
        degreesToRadians(left ? referenceTwist - twist : twist - referenceTwist),
        degreesToRadians(left ? outward - referenceOut : referenceOut - outward),
        "ZXY",
      ),
    ),
  );
  multiplyCharacterBoneQuaternion(
    model,
    `lowerarm_${sideSuffix}`,
    new Quaternion().setFromEuler(
      new Euler(degreesToRadians(elbow), 0, 0, "XYZ"),
    ),
  );
}

function multiplyCharacterBoneQuaternion(
  model: Object3D,
  boneName: string,
  rotation: Quaternion,
) {
  const bone = getCharacterBone(model, boneName);
  if (bone) bone.quaternion.multiply(rotation).normalize();
}

function applyMpfbArmPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  side: "L" | "R",
  posePreset: DirectorPosePreset,
  forward: number,
  outward: number,
  twist: number,
  elbow: number,
) {
  const left = side === "L";
  const sideSuffix = left ? "l" : "r";
  const mirror = left ? 1 : -1;
  let upperarmForward = forward;
  let upperarmOut = -40 + outward;
  let upperarmTwist = twist;
  let clavicleOut = 0;

  if (posePreset === "t-pose") {
    const referenceForward = left
      ? MPFB_T_POSE_REFERENCE.leftShoulderForward
      : MPFB_T_POSE_REFERENCE.rightShoulderForward;
    const referenceOut = left
      ? MPFB_T_POSE_REFERENCE.leftShoulderOut
      : MPFB_T_POSE_REFERENCE.rightShoulderOut;
    const referenceTwist = left
      ? MPFB_T_POSE_REFERENCE.leftShoulderTwist
      : MPFB_T_POSE_REFERENCE.rightShoulderTwist;
    upperarmForward = forward - referenceForward;
    upperarmOut = 32 + outward - referenceOut;
    upperarmTwist = twist - referenceTwist;
    clavicleOut = 15;
  }

  applyBindPoseEuler(
    model,
    bindPose,
    `clavicle_${sideSuffix}`,
    new Euler(0, 0, degreesToRadians(mirror * clavicleOut), "XYZ"),
  );
  applyBindPoseEuler(
    model,
    bindPose,
    `upperarm_${sideSuffix}`,
    new Euler(
      degreesToRadians(upperarmForward),
      degreesToRadians(left ? -upperarmTwist : upperarmTwist),
      degreesToRadians(mirror * upperarmOut),
      "XYZ",
    ),
  );
  // This fitted MPFB profile contains about 40 degrees of elbow flexion.
  // Subtract that native bend so a displayed value of 0 means a straight arm.
  applyBindPoseEuler(
    model,
    bindPose,
    `lowerarm_${sideSuffix}`,
    new Euler(degreesToRadians(elbow - 40), 0, 0, "XYZ"),
  );
}

function applyLegPose(
  model: Object3D,
  bindPose: CharacterBindPose,
  side: "L" | "R",
  posePreset: DirectorPosePreset,
  adjustments: DirectorPoseAdjustments,
  rigProfile: CharacterRigProfile,
) {
  const left = side === "L";
  // The reference crouch values intentionally contain small left/right
  // differences for the 41-bone mannequin. Mixamo's mirrored local frames
  // make those differences read as an unintended limp, so normalize only
  // this preset for the 28-bone rig while preserving the editor values.
  const isMixamoCrouch = rigProfile === "mixamo" && posePreset === "crouching";
  const forward = isMixamoCrouch
    ? (adjustments.leftHipForward + adjustments.rightHipForward) / 2
    : left
    ? adjustments.leftHipForward
    : adjustments.rightHipForward;
  const outward = isMixamoCrouch
    ? 0
    : left
      ? adjustments.leftHipOut
      : adjustments.rightHipOut;
  const twist = isMixamoCrouch
    ? 0
    : left
      ? adjustments.leftHipTwist
      : adjustments.rightHipTwist;
  const knee = isMixamoCrouch
    ? (adjustments.leftKneeBend + adjustments.rightKneeBend) / 2
    : left
      ? adjustments.leftKneeBend
      : adjustments.rightKneeBend;
  const thighName = `${side}_Thigh`;
  const calfName = `${side}_Calf`;

  if (rigProfile === "mixamo") {
    const forwardRotation = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      degreesToRadians(-forward),
    );
    const outwardRotation = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      degreesToRadians(left ? outward : -outward),
    );
    const localTwist = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      degreesToRadians(left ? -twist : twist),
    );
    applyModelSpaceBindPoseRotation(
      model,
      bindPose,
      thighName,
      outwardRotation.multiply(forwardRotation),
      localTwist,
    );
    const calfBone = getCharacterBone(model, calfName);
    const kneeEuler = calfBone?.name.startsWith("mixamorig")
      ? new Euler(degreesToRadians(-knee), 0, 0, "XYZ")
      : new Euler(0, 0, degreesToRadians(left ? -knee : knee), "XYZ");
    applyBindPoseEuler(
      model,
      bindPose,
      calfName,
      kneeEuler,
    );
    return;
  }

  applyBindPoseEuler(
    model,
    bindPose,
    thighName,
    new Euler(
      degreesToRadians(forward),
      degreesToRadians(left ? -twist : twist),
      degreesToRadians(left ? outward : -outward),
      "ZXY",
    ),
  );
  applyBindPoseEuler(
    model,
    bindPose,
    calfName,
    new Euler(degreesToRadians(-knee), 0, 0, "XYZ"),
  );
}

function applyMixamoCorePose(
  model: Object3D,
  bindPose: CharacterBindPose,
  adjustments: DirectorPoseAdjustments,
) {
  applyModelSpaceBindPoseRotation(
    model,
    bindPose,
    "Head",
    new Quaternion().setFromEuler(
      new Euler(
        degreesToRadians(-adjustments.headNod),
        degreesToRadians(-adjustments.headTurn),
        degreesToRadians(-adjustments.headTilt),
        "YXZ",
      ),
    ),
  );
  applyModelSpaceBindPoseRotation(
    model,
    bindPose,
    "Spine01",
    new Quaternion().setFromEuler(
      new Euler(
        degreesToRadians(-adjustments.torsoPitch),
        degreesToRadians(-adjustments.torsoTwist),
        degreesToRadians(-adjustments.torsoRoll),
        "YXZ",
      ),
    ),
  );
  applyModelSpaceBindPoseRotation(
    model,
    bindPose,
    "Hip",
    new Quaternion().setFromEuler(
      new Euler(
        degreesToRadians(-adjustments.bodyPitch),
        degreesToRadians(-adjustments.bodyTurn),
        degreesToRadians(-adjustments.bodyRoll),
        "YXZ",
      ),
    ),
  );
}

function applyModelSpaceBindPoseRotation(
  model: Object3D,
  bindPose: CharacterBindPose,
  boneName: string,
  modelSpaceRotation: Quaternion,
  localRotation = new Quaternion(),
) {
  const resolvedName = resolveCharacterBoneName(model, boneName);
  const bone = model.getObjectByName(resolvedName);
  const bindQuaternion = bindPose.get(resolvedName);
  if (!bone || !bone.parent || !bindQuaternion) return;

  bone.quaternion.copy(bindQuaternion);
  model.updateMatrixWorld(true);
  const modelWorldQuaternion = model.getWorldQuaternion(new Quaternion());
  const worldRotation = modelWorldQuaternion
    .clone()
    .multiply(modelSpaceRotation)
    .multiply(modelWorldQuaternion.clone().invert());
  const desiredWorldQuaternion = worldRotation
    .multiply(bone.getWorldQuaternion(new Quaternion()))
    .multiply(localRotation);
  const parentWorldInverse = bone.parent
    .getWorldQuaternion(new Quaternion())
    .invert();
  bone.quaternion
    .copy(parentWorldInverse.multiply(desiredWorldQuaternion))
    .normalize();
  model.updateMatrixWorld(true);
}

export function getCharacterBonePositionInModelSpace(
  model: Object3D,
  boneName: string,
) {
  const bone = getCharacterBone(model, boneName);
  if (!bone) return null;
  model.updateMatrixWorld(true);
  return bone
    .getWorldPosition(new Vector3())
    .applyMatrix4(model.matrixWorld.clone().invert());
}

function applyBindPoseEuler(
  model: Object3D,
  bindPose: CharacterBindPose,
  boneName: string,
  rotation: Euler,
) {
  const resolvedName = resolveCharacterBoneName(model, boneName);
  const bone = model.getObjectByName(resolvedName);
  const bindQuaternion = bindPose.get(resolvedName);
  if (!bone || !bindQuaternion) return;

  bone.quaternion
    .copy(bindQuaternion)
    .multiply(new Quaternion().setFromEuler(rotation))
    .normalize();
}

function applyBindPoseQuaternion(
  model: Object3D,
  bindPose: CharacterBindPose,
  boneName: string,
  rotation: Quaternion,
) {
  const resolvedName = resolveCharacterBoneName(model, boneName);
  const bone = model.getObjectByName(resolvedName);
  const bindQuaternion = bindPose.get(resolvedName);
  if (!bone || !bindQuaternion) return;

  bone.quaternion.copy(bindQuaternion).multiply(rotation).normalize();
}

function getCharacterRigProfile(model: Object3D): CharacterRigProfile {
  if (model.getObjectByName("ball_leaf_l")) return "quaternius-ual";
  if (model.getObjectByName("upperarm_l")) return "mpfb-game-engine";
  if (
    getMixamoBone(model, "Hips") &&
    getMixamoBone(model, "LeftArm") &&
    getMixamoBone(model, "RightArm")
  ) {
    return "mixamo";
  }
  let customDirectorRig = false;
  model.traverse((child) => {
    if (
      child.userData.director_rig_profile === "director-41-custom-v1" ||
      child.userData.director_rig_profile === "director-41-component-rigid-v1" ||
      child.userData.director_rig_profile === "director-41-surface-transfer-v1"
    ) {
      customDirectorRig = true;
    }
  });
  if (customDirectorRig) return "director-41-custom";
  return "director-41";
}

function resolveCharacterBoneName(model: Object3D, boneName: string) {
  const profile = getCharacterRigProfile(model);
  if (profile.startsWith("director-41")) return boneName;
  if (profile === "mixamo") {
    const mixamoName = MIXAMO_BONE_ALIASES[boneName] ?? boneName;
    return getMixamoBone(model, mixamoName)?.name ?? mixamoName;
  }
  return MPFB_BONE_ALIASES[boneName] ?? boneName;
}

function getMixamoBone(model: Object3D, boneName: string) {
  return (
    model.getObjectByName(boneName) ??
    model.getObjectByName(`mixamorig${boneName}`) ??
    model.getObjectByName(`mixamorig:${boneName}`)
  );
}

export function getCharacterBone(model: Object3D, boneName: string) {
  return model.getObjectByName(resolveCharacterBoneName(model, boneName));
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}
