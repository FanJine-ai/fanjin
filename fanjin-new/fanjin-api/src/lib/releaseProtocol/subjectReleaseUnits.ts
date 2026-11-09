// Fixed public role identifiers from the Subject Release v1 wire contract.
export const SUBJECT_RELEASE_UNIT_IDS = Object.freeze([
  "web-user-admin", "api", "worker", "database-migration",
] as const);
export type SubjectReleaseUnitId = typeof SUBJECT_RELEASE_UNIT_IDS[number];
