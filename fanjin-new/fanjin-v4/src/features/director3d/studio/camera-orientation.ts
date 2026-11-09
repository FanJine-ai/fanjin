export function getUprightCameraRotation(
  position: [number, number, number],
  target: [number, number, number],
  localRotation: [number, number, number],
): [number, number, number] {
  const offsetX = target[0] - position[0];
  const offsetY = target[1] - position[1];
  const offsetZ = target[2] - position[2];
  const horizontalDistance = Math.hypot(offsetX, offsetZ);

  if (horizontalDistance < 0.0001 && Math.abs(offsetY) < 0.0001) {
    return localRotation;
  }

  return [
    -Math.atan2(offsetY, horizontalDistance) + localRotation[0],
    horizontalDistance < 0.0001
      ? localRotation[1]
      : Math.atan2(offsetX, offsetZ) + localRotation[1],
    localRotation[2],
  ];
}

/**
 * Scene camera helpers point their lens along local +Z, while the inspector's
 * positive pitch means tilting the lens downward. Convert that UI convention
 * to the Euler rotation used by the visible helper without changing yaw.
 */
export function getCameraHelperRotation(
  position: [number, number, number],
  target: [number, number, number],
): [number, number, number] {
  const [pitch, yaw] = getUprightCameraRotation(position, target, [0, 0, 0]);
  return [-pitch, yaw, 0];
}

/** Rebuild a manual look-at point from inspector rotation values. */
export function getCameraTargetFromRotation(
  position: [number, number, number],
  rotation: [number, number, number],
  distance: number,
): [number, number, number] {
  const [pitch, yaw] = rotation;
  const safeDistance = Math.max(0.01, distance);
  const horizontal = Math.cos(pitch) * safeDistance;

  return [
    position[0] + Math.sin(yaw) * horizontal,
    position[1] - Math.sin(pitch) * safeDistance,
    position[2] + Math.cos(yaw) * horizontal,
  ];
}
