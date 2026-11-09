export type PlatformReleaseChannel = "stable" | "beta" | "internal";
export type PlatformReleaseStatus = "draft" | "deploying" | "published" | "archived";

export interface PlatformReleaseRecord {
  id: string;
  version: string;
  title: string;
  channel: PlatformReleaseChannel;
  summary: string;
  releaseNotes: string;
  status: PlatformReleaseStatus;
  revision: number;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  publishedByUserId: number | null;
  archivedByUserId: number | null;
  publishedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformReleaseSummary {
  currentStable: PlatformReleaseRecord | null;
  draftCount: number;
  betaCount: number;
  latestPublishedAt: number | null;
}

export interface PlatformReleasePage {
  items: PlatformReleaseRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
  summary: PlatformReleaseSummary;
}

export interface PlatformReleaseDraft {
  version: string;
  title: string;
  channel: PlatformReleaseChannel;
  summary: string;
  releaseNotes: string;
}

export type ReleaseArtifactStatus = "registered" | "ready" | "rejected";
export type ReleaseDeploymentTargetRole = "api" | "worker";

export interface ReleaseArtifactManifestTarget {
  key: string;
  label: string;
  role: ReleaseDeploymentTargetRole;
  serverId?: string;
  zone?: string;
  wave: number;
}

export interface ReleaseArtifactManifest extends Record<string, unknown> {
  manifestVersion: 1;
  format: "fanjin-release/v1";
  releaseId: string;
  sourceCommit: string;
  schemaVersion: number;
  workerProtocolVersion: number;
  schemaMode: "schema-neutral";
  web: { assetStrategy: "shared-union-v1" };
}

export interface ReleaseArtifactRecord {
  id: string;
  releaseId: string;
  fileName: string | null;
  byteSize: number | null;
  sha256: string;
  sourceCommit: string | null;
  manifest: ReleaseArtifactManifest;
  status: ReleaseArtifactStatus;
  rejectionReason: string | null;
  verifiedAt: number | null;
  revision: number;
  idempotentReplay?: boolean;
}

export interface ReleaseArtifactVerificationJob {
  jobId: string;
  artifactId: string;
  revision: number;
  status: "queued" | "running" | "ready" | "failed";
  pollAfterMs?: number;
  createdAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  artifact?: ReleaseArtifactRecord;
  errorCode?: string;
  message?: string;
}

export interface RegisterReleaseArtifactInput {
  releaseId: string;
  reservationId: string;
  sha256: string;
  manifest: ReleaseArtifactManifest;
  idempotencyKey: string;
}

export interface ReleaseArtifactUploadTarget {
  reservationId: string;
  url: string;
  method: "PUT";
  expiresAt: number;
  requiredHeaders: {
    "Content-Type": "application/gzip";
  };
  idempotent: boolean;
}

export interface ReleaseArtifactMultipartPartSummary {
  partNumber: number;
  byteSize: number;
}

export interface ReleaseArtifactMultipartSession {
  protocolVersion: "release-artifact-multipart/v1";
  sessionId: string;
  reservationId: string;
  releaseId: string;
  partSize: number;
  partCount: number;
  byteSize: number;
  sha256: string;
  expiresAt: number;
  status: "active" | "completing" | "aborting" | "completed" | "aborted" | "expired";
  uploadedParts: ReleaseArtifactMultipartPartSummary[];
  uploadedByteSize: number;
  resumeGrant?: string;
  idempotent?: boolean;
}

export interface ReleaseArtifactMultipartPartTarget {
  sessionId: string;
  partNumber: number;
  byteOffset: number;
  byteSize: number;
  url: string;
  method: "PUT";
  expiresAt: number;
  requiredHeaders: Record<string, never>;
}

export interface ReleaseArtifactUploadReceipt {
  reservationId: string;
  sessionId?: string;
}

export interface ReleaseArtifactSidecar {
  format: "fanjin-release-artifact/v1";
  artifactSha256: string;
  artifactBytes: number;
  manifest: ReleaseArtifactManifest;
}

export interface ReleaseDeploymentPlanTarget extends ReleaseArtifactManifestTarget {
  ordinal: number;
}

export interface ReleaseDeploymentPlan {
  planVersion: 1;
  previewDigest?: string;
  previewReleaseRevision?: number;
  artifactSchemaVersion: number;
  strategy: "rolling";
  releaseId: string;
  artifactId: string;
  environment: string;
  scope: string;
  maxUnavailable: number;
  minHealthyTargets: number;
  drainTimeoutMs: number;
  readinessTimeoutMs: number;
  rollbackOnFailure: boolean;
  targets: ReleaseDeploymentPlanTarget[];
  waves: Array<{ wave: number; targetKeys: string[] }>;
}

export interface ReleaseDeploymentPreview {
  releaseId: string;
  releaseVersion: string;
  releaseRevision: number;
  releaseStatus: PlatformReleaseStatus;
  artifactId: string;
  artifactStatus: ReleaseArtifactStatus;
  artifactRevision: number;
  previewDigest: string;
  plan: ReleaseDeploymentPlan;
}

export type ReleaseDeploymentStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "rolling_back"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled_back"
  | "degraded_manual";

export type ReleaseDeploymentTargetStatus =
  | "pending"
  | "draining"
  | "deploying"
  | "verifying"
  | "rolling_back"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "rolled_back";

export interface ReleaseDeploymentRecord {
  id: string;
  releaseId: string;
  artifactId: string;
  previousReleaseId: string | null;
  previousArtifactId: string | null;
  environment: string;
  scope: string;
  strategy: "rolling";
  status: ReleaseDeploymentStatus;
  activeScope: string | null;
  idempotencyKey?: string;
  requestHash?: string;
  plan: ReleaseDeploymentPlan;
  phase: string;
  checkpoint?: Record<string, unknown>;
  targetCount: number;
  completedTargetCount: number;
  succeededTargetCount: number;
  failedTargetCount: number;
  maxUnavailable: number;
  minHealthyTargets: number;
  drainTimeoutMs: number;
  readinessTimeoutMs: number;
  rollbackOnFailure: boolean;
  requestedByUserId: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelRequestedAt: number | null;
  cancelRequestedByUserId?: number | null;
  cancelReason: string | null;
  manualInterventionRequired: boolean;
  fencingToken?: number;
  errorCode: string | null;
  safeError: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  idempotentReplay?: boolean;
}

export interface ReleaseDeploymentTargetRecord {
  id: string;
  deploymentId: string;
  targetKey: string;
  targetLabel: string;
  role: ReleaseDeploymentTargetRole;
  ordinal: number;
  metadata: Record<string, unknown>;
  status: ReleaseDeploymentTargetStatus;
  attempt: number;
  previousReleaseId?: string | null;
  previousArtifactId?: string | null;
  observedArtifactId: string | null;
  observedVersion: string | null;
  drainStartedAt: number | null;
  deployStartedAt: number | null;
  verifiedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  safeError: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReleaseDeploymentDetail extends ReleaseDeploymentRecord {
  targets: ReleaseDeploymentTargetRecord[];
}

export interface ReleaseDeploymentPage {
  items: ReleaseDeploymentRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
}

export type ReleaseDeploymentEventLevel = "info" | "warning" | "error";
export type ReleaseDeploymentEventActor = "operator" | "orchestrator" | "target";

export interface ReleaseDeploymentEvent {
  id: string;
  deploymentId: string;
  targetId: string | null;
  sequence: number;
  eventType: string;
  phase: string;
  level: ReleaseDeploymentEventLevel;
  actor: ReleaseDeploymentEventActor;
  actorUserId: number | null;
  requestId?: string | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ReleaseDeploymentEventPage {
  items: ReleaseDeploymentEvent[];
  nextSeq?: number;
}

export type ReleaseReconciliationIntent = "previous" | "target";
export type ReleaseReconciliationStatus = "queued" | "running" | "succeeded" | "failed";

export interface ReleaseDeploymentReconciliationRecord {
  id: string;
  deploymentId: string;
  intent: ReleaseReconciliationIntent;
  status: ReleaseReconciliationStatus;
  reason: string;
  idempotencyKey: string;
  requestedDeploymentRevision: number;
  requestedByUserId: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  fencingToken: number;
  evidence: Record<string, unknown>;
  errorCode: string | null;
  safeError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deploymentRevision: number;
  idempotentReplay?: boolean;
}

export interface PreviewReleaseDeploymentInput {
  releaseId: string;
  releaseRevision: number;
  artifactId: string;
  targetKeys?: string[];
}

export interface StartReleaseDeploymentInput extends PreviewReleaseDeploymentInput {
  idempotencyKey: string;
  previewDigest: string;
}

export interface ReconcileReleaseDeploymentInput {
  id: string;
  revision: number;
  intent: ReleaseReconciliationIntent;
  reason: string;
  idempotencyKey: string;
}
