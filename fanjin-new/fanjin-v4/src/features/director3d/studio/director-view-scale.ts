export const DIRECTOR_VIEW_SCALE = {
  referenceScale: 3,
  fov: 46,
  /** Default director view: a low-angle perspective about 5.7° below level. */
  initialPolarAngle: Math.PI / 2 - 0.1,
  /** Must match the fixed 20×20 stage half-size. */
  stageHalfSize: 10,
  minScale: 0.2,
  /** Maximum editor zoom (3000%). */
  maxScale: 30,
  /** Keep pose editing aligned with the normal editor zoom limit. */
  poseMaxScale: 30,
} as const;

/**
 * At 300%, the default low-angle perspective keeps the fixed 20×20 stage
 * framed at the calibrated editor distance.
 */
export function getDirectorOverviewDistance(scale: number) {
  const distanceAtReference =
    DIRECTOR_VIEW_SCALE.stageHalfSize /
    Math.tan((DIRECTOR_VIEW_SCALE.fov * Math.PI) / 360);

  return distanceAtReference * (DIRECTOR_VIEW_SCALE.referenceScale / scale);
}

export function getDirectorViewScale(distance: number) {
  const distanceAtReference = getDirectorOverviewDistance(
    DIRECTOR_VIEW_SCALE.referenceScale,
  );
  const scale =
    (distanceAtReference * DIRECTOR_VIEW_SCALE.referenceScale) / distance;

  return Math.min(
    DIRECTOR_VIEW_SCALE.maxScale,
    Math.max(DIRECTOR_VIEW_SCALE.minScale, scale),
  );
}
