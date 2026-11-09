import {
  Bone,
  BoxGeometry,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";
import type { DirectorCharacterModel } from "./types";

export interface DirectorProceduralCharacterProfile {
  upperLegLength: number;
  lowerLegLength: number;
  upperArmLength: number;
  lowerArmLength: number;
  lowerTorsoLength: number;
  upperTorsoLength: number;
  shoulderWidth: number;
  hipWidth: number;
  torsoWidth: number;
  torsoDepth: number;
  limbRadius: number;
  headRadius: number;
  handSize: number;
  footLength: number;
}

/**
 * Locally authored body proportions for the eight director-studio silhouettes.
 * The values are scene units before the existing visual-scale correction is
 * applied, so saved 0.2.0 scenes keep the same scale semantics as the delivered
 * studio contract without bundling third-party character files.
 */
export const DIRECTOR_PROCEDURAL_CHARACTER_PROFILES: Readonly<
  Record<DirectorCharacterModel, DirectorProceduralCharacterProfile>
> = {
  "adult-male": {
    upperLegLength: 0.27,
    lowerLegLength: 0.25,
    upperArmLength: 0.22,
    lowerArmLength: 0.2,
    lowerTorsoLength: 0.17,
    upperTorsoLength: 0.21,
    shoulderWidth: 0.34,
    hipWidth: 0.2,
    torsoWidth: 0.31,
    torsoDepth: 0.18,
    limbRadius: 0.055,
    headRadius: 0.135,
    handSize: 0.075,
    footLength: 0.18,
  },
  "adult-female": {
    upperLegLength: 0.27,
    lowerLegLength: 0.25,
    upperArmLength: 0.21,
    lowerArmLength: 0.19,
    lowerTorsoLength: 0.17,
    upperTorsoLength: 0.2,
    shoulderWidth: 0.3,
    hipWidth: 0.22,
    torsoWidth: 0.27,
    torsoDepth: 0.16,
    limbRadius: 0.048,
    headRadius: 0.135,
    handSize: 0.07,
    footLength: 0.17,
  },
  teenager: {
    upperLegLength: 0.35,
    lowerLegLength: 0.32,
    upperArmLength: 0.27,
    lowerArmLength: 0.24,
    lowerTorsoLength: 0.2,
    upperTorsoLength: 0.23,
    shoulderWidth: 0.34,
    hipWidth: 0.2,
    torsoWidth: 0.3,
    torsoDepth: 0.17,
    limbRadius: 0.052,
    headRadius: 0.14,
    handSize: 0.075,
    footLength: 0.19,
  },
  "young-child": {
    upperLegLength: 0.29,
    lowerLegLength: 0.25,
    upperArmLength: 0.22,
    lowerArmLength: 0.19,
    lowerTorsoLength: 0.18,
    upperTorsoLength: 0.21,
    shoulderWidth: 0.3,
    hipWidth: 0.2,
    torsoWidth: 0.27,
    torsoDepth: 0.17,
    limbRadius: 0.052,
    headRadius: 0.17,
    handSize: 0.072,
    footLength: 0.17,
  },
  slender: {
    upperLegLength: 0.28,
    lowerLegLength: 0.26,
    upperArmLength: 0.23,
    lowerArmLength: 0.21,
    lowerTorsoLength: 0.17,
    upperTorsoLength: 0.21,
    shoulderWidth: 0.29,
    hipWidth: 0.17,
    torsoWidth: 0.24,
    torsoDepth: 0.13,
    limbRadius: 0.038,
    headRadius: 0.125,
    handSize: 0.06,
    footLength: 0.17,
  },
  broad: {
    upperLegLength: 0.27,
    lowerLegLength: 0.25,
    upperArmLength: 0.22,
    lowerArmLength: 0.2,
    lowerTorsoLength: 0.17,
    upperTorsoLength: 0.21,
    shoulderWidth: 0.42,
    hipWidth: 0.25,
    torsoWidth: 0.39,
    torsoDepth: 0.23,
    limbRadius: 0.068,
    headRadius: 0.14,
    handSize: 0.085,
    footLength: 0.2,
  },
  chibi: {
    upperLegLength: 0.33,
    lowerLegLength: 0.29,
    upperArmLength: 0.27,
    lowerArmLength: 0.22,
    lowerTorsoLength: 0.21,
    upperTorsoLength: 0.24,
    shoulderWidth: 0.42,
    hipWidth: 0.29,
    torsoWidth: 0.38,
    torsoDepth: 0.25,
    limbRadius: 0.075,
    headRadius: 0.36,
    handSize: 0.11,
    footLength: 0.24,
  },
  muscular: {
    upperLegLength: 0.38,
    lowerLegLength: 0.34,
    upperArmLength: 0.31,
    lowerArmLength: 0.28,
    lowerTorsoLength: 0.23,
    upperTorsoLength: 0.27,
    shoulderWidth: 0.51,
    hipWidth: 0.29,
    torsoWidth: 0.45,
    torsoDepth: 0.27,
    limbRadius: 0.09,
    headRadius: 0.15,
    handSize: 0.105,
    footLength: 0.23,
  },
};

const RIG_PROFILE = "director-41-custom-v1";

function createBone(name: string, x = 0, y = 0, z = 0) {
  const bone = new Bone();
  bone.name = name;
  bone.position.set(x, y, z);
  return bone;
}

function createMaterial(name: string) {
  const material = new MeshStandardMaterial({
    color: "#d2a679",
    roughness: 0.76,
    metalness: 0.02,
  });
  material.name = name;
  return material;
}

function addCapsule(
  parent: Bone,
  name: string,
  radius: number,
  length: number,
  direction: 1 | -1,
  materialName = "Director_Armor_Primary",
) {
  const mesh = new Mesh(
    new CapsuleGeometry(radius, Math.max(length - radius * 2, 0.01), 4, 8),
    createMaterial(materialName),
  );
  mesh.name = name;
  mesh.position.y = (direction * length) / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addJoint(
  parent: Bone,
  name: string,
  radius: number,
  materialName = "Director_Joint_Seam",
) {
  const mesh = new Mesh(
    new SphereGeometry(radius, 12, 8),
    createMaterial(materialName),
  );
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addArm(
  chest: Bone,
  side: "L" | "R",
  profile: DirectorProceduralCharacterProfile,
) {
  const mirror = side === "L" ? 1 : -1;
  const clavicle = createBone(`${side}_Clavicle`);
  const upperarm = createBone(
    `${side}_Upperarm`,
    (mirror * profile.shoulderWidth) / 2,
  );
  // Arms use a positive local Y chain with a 180° bind rotation. This matches
  // the delivered director-41 control convention while resting at the sides.
  upperarm.rotation.z = Math.PI;
  const forearm = createBone(`${side}_Forearm`, 0, profile.upperArmLength);
  const hand = createBone(`${side}_Hand`, 0, profile.lowerArmLength);

  chest.add(clavicle);
  clavicle.add(upperarm);
  upperarm.add(forearm);
  forearm.add(hand);

  addJoint(upperarm, `${side}_Shoulder_Mesh`, profile.limbRadius * 1.2);
  addCapsule(
    upperarm,
    `${side}_Upperarm_Mesh`,
    profile.limbRadius,
    profile.upperArmLength,
    1,
  );
  addJoint(forearm, `${side}_Elbow_Mesh`, profile.limbRadius * 1.06);
  addCapsule(
    forearm,
    `${side}_Forearm_Mesh`,
    profile.limbRadius * 0.88,
    profile.lowerArmLength,
    1,
  );
  const handMesh = new Mesh(
    new BoxGeometry(
      profile.handSize * 0.78,
      profile.handSize * 1.32,
      profile.handSize * 0.48,
    ),
    createMaterial("Director_Armor_Secondary"),
  );
  handMesh.name = `${side}_Hand_Mesh`;
  handMesh.position.y = profile.handSize * 0.56;
  handMesh.castShadow = true;
  handMesh.receiveShadow = true;
  hand.add(handMesh);
}

function addLeg(
  hip: Bone,
  side: "L" | "R",
  profile: DirectorProceduralCharacterProfile,
) {
  const mirror = side === "L" ? 1 : -1;
  const thigh = createBone(
    `${side}_Thigh`,
    (mirror * profile.hipWidth) / 2,
  );
  const calf = createBone(`${side}_Calf`, 0, -profile.upperLegLength);
  const foot = createBone(`${side}_Foot`, 0, -profile.lowerLegLength);

  hip.add(thigh);
  thigh.add(calf);
  calf.add(foot);

  addJoint(thigh, `${side}_Hip_Mesh`, profile.limbRadius * 1.3);
  addCapsule(
    thigh,
    `${side}_Thigh_Mesh`,
    profile.limbRadius * 1.08,
    profile.upperLegLength,
    -1,
  );
  addJoint(calf, `${side}_Knee_Mesh`, profile.limbRadius * 1.08);
  addCapsule(
    calf,
    `${side}_Calf_Mesh`,
    profile.limbRadius * 0.94,
    profile.lowerLegLength,
    -1,
  );
  const footMesh = new Mesh(
    new BoxGeometry(
      profile.limbRadius * 1.8,
      profile.limbRadius * 0.75,
      profile.footLength,
    ),
    createMaterial("Director_Armor_Secondary"),
  );
  footMesh.name = `${side}_Foot_Mesh`;
  footMesh.position.set(0, profile.limbRadius * 0.42, profile.footLength * 0.28);
  footMesh.castShadow = true;
  footMesh.receiveShadow = true;
  foot.add(footMesh);
}

/** Build a complete, poseable character using only Three.js primitives. */
export function createProceduralDirectorCharacter(
  characterModel: DirectorCharacterModel,
) {
  const profile = DIRECTOR_PROCEDURAL_CHARACTER_PROFILES[characterModel];
  const model = new Group();
  model.name = `Director_Procedural_${characterModel}`;
  model.userData.director_rig_profile = RIG_PROFILE;
  model.userData.director_character_model = characterModel;

  const root = createBone("Root");
  const hip = createBone(
    "Hip",
    0,
    profile.upperLegLength + profile.lowerLegLength,
  );
  const spine01 = createBone("Spine01", 0, profile.limbRadius * 0.5);
  const spine02 = createBone("Spine02", 0, profile.lowerTorsoLength);
  const head = createBone(
    "Head",
    0,
    profile.upperTorsoLength + profile.headRadius * 1.18,
  );
  const headTop = createBone("HeadTop_End", 0, profile.headRadius);

  model.add(root);
  root.add(hip);
  hip.add(spine01);
  spine01.add(spine02);
  spine02.add(head);
  head.add(headTop);

  const pelvis = new Mesh(
    new SphereGeometry(0.5, 14, 10),
    createMaterial("Director_Suit_Undersuit"),
  );
  pelvis.name = "Director_Pelvis_Mesh";
  pelvis.scale.set(profile.hipWidth * 0.76, profile.limbRadius * 1.45, profile.torsoDepth * 0.56);
  pelvis.castShadow = true;
  pelvis.receiveShadow = true;
  hip.add(pelvis);

  const torso = new Mesh(
    new SphereGeometry(0.5, 16, 10),
    createMaterial("Director_Armor_Secondary"),
  );
  torso.name = "Director_Torso_Mesh";
  torso.position.y =
    (profile.lowerTorsoLength + profile.upperTorsoLength * 0.72) / 2;
  torso.scale.set(
    profile.torsoWidth,
    profile.lowerTorsoLength + profile.upperTorsoLength * 0.78,
    profile.torsoDepth,
  );
  torso.castShadow = true;
  torso.receiveShadow = true;
  spine01.add(torso);

  const headMesh = addJoint(
    head,
    "Director_Head_Mesh",
    profile.headRadius,
    "Director_Armor_Primary",
  );
  headMesh.scale.set(0.82, 1, 0.88);
  const face = new Mesh(
    new SphereGeometry(profile.headRadius * 0.16, 8, 6),
    createMaterial("Director_Joint_Seam"),
  );
  face.name = "Director_Face_Direction";
  face.position.set(0, 0, profile.headRadius * 0.82);
  head.add(face);

  const chestArmHeight = profile.upperTorsoLength * 0.72;
  const leftArmAnchor = createBone("Director_Left_Arm_Anchor", 0, chestArmHeight);
  const rightArmAnchor = createBone("Director_Right_Arm_Anchor", 0, chestArmHeight);
  spine02.add(leftArmAnchor, rightArmAnchor);
  addArm(leftArmAnchor, "L", profile);
  addArm(rightArmAnchor, "R", profile);
  addLeg(hip, "L", profile);
  addLeg(hip, "R", profile);

  model.updateMatrixWorld(true);
  return model;
}
