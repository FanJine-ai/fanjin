/**
 * Signed release/runtime capability for the Volcengine portrait asset lane.
 *
 * Keep these identifiers centralized: the release manifest, FD4 bootstrap,
 * FD6 exact credential envelope and readiness projection must all bind the
 * same immutable strings.
 */
export const PORTRAIT_ASSETS_RUNTIME_CAPABILITY = "portrait-assets-v1" as const;

/**
 * ImageX review is deliberately a separate signed capability. Possessing the
 * portrait-assets credential does not prove that the isolated ImageX service,
 * ServiceId and AK/SK slot were authorized for moderation.
 */
export const PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY =
  "volcano.imagex.portrait_review.v1" as const;

export const FORMAL_CANDIDATE_PORTRAIT_PROVIDER = "volcano" as const;
export const FORMAL_CANDIDATE_PORTRAIT_ENDPOINT_TYPE =
  "video_generation" as const;
export const FORMAL_CANDIDATE_PORTRAIT_MODEL =
  "volcano-portrait-assets" as const;
/**
 * The public workspace relay must not reuse the platform portrait grant. Its
 * distinct model scope binds FD6 use to the one workspace-owned relay channel
 * selected by the root envelope builder.
 */
export const FORMAL_CANDIDATE_PORTRAIT_ASSET_RELAY_MODEL =
  "volcano-portrait-asset-relay" as const;
export const FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MODEL =
  PORTRAIT_IMAGEX_REVIEW_RUNTIME_CAPABILITY;

/**
 * One formal activation may create one virtual group+asset (2 calls), or one
 * real-person validation session+result+asset (3 calls). Four exact uses leave
 * one bounded recovery attempt without granting an open-ended credential.
 */
export const FORMAL_CANDIDATE_PORTRAIT_MAXIMUM_USES = 4 as const;
/**
 * One formal relay exercise may cover all 12 Actions. Seven mutations consume
 * one use each and five read Actions may use the client's three bounded
 * attempts (22 total); two additional uses cover harness/readiness recovery.
 * The containing FD6 envelope expires after 60 seconds.
 */
export const FORMAL_CANDIDATE_PORTRAIT_ASSET_RELAY_MAXIMUM_USES = 24 as const;
/**
 * Exactly three logical ImageX operations are available to one formal run:
 * image face detection, image moderation, and one video-review lease. The
 * lease consumes one FD6 use and internally bounds its single POST plus at
 * most 120 GET polls, so upstream HTTP attempts never inflate FD6 scope.
 */
export const FORMAL_CANDIDATE_PORTRAIT_IMAGEX_REVIEW_MAXIMUM_USES = 3 as const;
