import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Cpu,
  FileCheck2,
  PackageCheck,
  RotateCcw,
  Server,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  FormField,
  Input,
  Tabs,
} from "../../../ui/console";
import {
  acquireReleasePipelineProofs,
  markReleaseArtifactReady,
  previewReleaseDeployment,
  registerReleaseArtifact,
  startReleaseDeployment,
  uploadAndRegisterReleaseArtifact,
  type ReleasePipelineProofs,
} from "./api";
import {
  createIdempotencyKey,
  isUuid,
  parseArtifactSidecarText,
  releaseArtifactDisplayIdentity,
} from "./releasePlan";
import {
  isReleaseSafetyGateSatisfied,
  shouldClearReleasePreview,
} from "./releaseSafetyGate";
import {
  abortReleaseArtifactMultipart,
  clearReleaseArtifactMultipartCheckpoint,
  loadReleaseArtifactMultipartCheckpoint,
  releaseArtifactMultipartCheckpointMatchesFile,
} from "./releaseArtifactMultipart";
import { targetRoleLabels } from "./deploymentState";
import type {
  PlatformReleaseRecord,
  ReleaseArtifactRecord,
  ReleaseArtifactSidecar,
  ReleaseArtifactUploadReceipt,
  ReleaseDeploymentDetail,
  ReleaseDeploymentPlanTarget,
  ReleaseDeploymentPreview,
  ReleaseDeploymentTargetRole,
} from "./types";

type ArtifactMode = "upload" | "existing";
type BusyAction = "upload" | "verify" | "preview" | "start" | null;
type RegistrationErrors = Partial<Record<"archive" | "sidecar" | "artifactId", string>>;

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;

function formatBytes(value: number | null | undefined) {
  if (!value) return "未填写";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function shortDigest(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function ArtifactSummary({ artifact }: { artifact: ReleaseArtifactRecord }) {
  const display = releaseArtifactDisplayIdentity(artifact);
  return (
    <section className="releaseArtifactSummary" aria-label="已登记制品">
      <div className="releaseArtifactSummary__head">
        <span className="releaseArtifactSummary__icon" aria-hidden="true"><PackageCheck size={18} /></span>
        <div>
          <strong>{display.name}</strong>
          <span>制品 ID：{display.id}</span>
        </div>
        <Badge tone={artifact.status === "ready" ? "success" : artifact.status === "rejected" ? "danger" : "warning"}>
          {artifact.status === "ready" ? "校验通过" : artifact.status === "rejected" ? "校验拒绝" : "等待校验"}
        </Badge>
      </div>
      <dl>
        <div><dt>SHA-256</dt><dd title={artifact.sha256}>{shortDigest(artifact.sha256)}</dd></div>
        <div><dt>来源提交</dt><dd>{artifact.sourceCommit || artifact.manifest.sourceCommit}</dd></div>
        <div><dt>制品大小</dt><dd>{formatBytes(artifact.byteSize)}</dd></div>
        <div><dt>数据库代际</dt><dd>{artifact.manifest.schemaVersion}</dd></div>
        <div><dt>任务协议代际</dt><dd>{artifact.manifest.workerProtocolVersion ?? "未记录"}</dd></div>
      </dl>
    </section>
  );
}

const planActions: Record<ReleaseDeploymentTargetRole, string[]> = {
  api: ["CLB 摘流", "连接排空", "激活新版", "直连验活", "恢复流量"],
  worker: ["停止接单", "任务归零", "激活新版", "心跳验活", "恢复接单"],
};

function PlanTarget({ target, index }: { target: ReleaseDeploymentPlanTarget; index: number }) {
  const roleLabel = targetRoleLabels[target.role];
  return (
    <li>
      <span className="releasePlanTargetOrder">{index + 1}</span>
      <div className="releasePlanTargetCopy">
        <span className="releasePlanTargetRole">
          {target.role === "worker" ? <Cpu size={13} aria-hidden="true" /> : <Server size={13} aria-hidden="true" />}
          {roleLabel}
        </span>
        <strong>{target.label}</strong>
        <span>{target.key}{target.zone ? ` / ${target.zone}` : ""}</span>
      </div>
      <div className="releasePlanTargetActions" aria-label={`${target.label} ${roleLabel} 发布动作`}>
        {planActions[target.role].map((action, actionIndex) => (
          <span className="releasePlanTargetAction" key={action}>
            <span>{action}</span>
            {actionIndex < planActions[target.role].length - 1 ? <ChevronRight size={13} aria-hidden="true" /> : null}
          </span>
        ))}
      </div>
    </li>
  );
}

function PlanPreview({ preview }: { preview: ReleaseDeploymentPreview }) {
  const apiTargets = preview.plan.targets.filter((target) => target.role === "api");
  const workerTargets = preview.plan.targets.filter((target) => target.role === "worker");
  const executionTargets = workerTargets.length
    ? [workerTargets[0], ...apiTargets, ...workerTargets.slice(1)]
    : apiTargets;
  const roleGroups = [
    {
      key: "worker-bridge",
      role: "worker" as const,
      title: "① 建立新版 Worker 兼容桥",
      description: "先升级一台 Worker；旧、新 Worker 同时接单，为 API 跨版本滚动保留匹配的任务执行端。",
      targets: workerTargets.slice(0, 1),
    },
    {
      key: "api-fleet",
      role: "api" as const,
      title: "② 逐台升级全部 API",
      description: "每次只从 CLB 摘流一台，连接排空、直连验活并恢复原权重后才处理下一台。",
      targets: apiTargets,
    },
    {
      key: "worker-converge",
      role: "worker" as const,
      title: "③ 收敛剩余 Worker",
      description: "全部 API 已到新版后，再逐台停止接单、等待在途任务归零并升级剩余 Worker。",
      targets: workerTargets.slice(1),
    },
  ];
  return (
    <div className="releasePlanPreview">
      <div className="releasePlanFacts">
        <div><span>受管拓扑</span><strong>{apiTargets.length} API / {workerTargets.length} Worker</strong></div>
        <div><span>发布策略</span><strong>Worker 桥接式逐台滚动</strong></div>
        <div><span>API 安全容量</span><strong>最多摘流 {preview.plan.maxUnavailable} 台，至少健康 {preview.plan.minHealthyTargets} 台</strong></div>
        <div><span>失败处理</span><strong>{preview.plan.rollbackOnFailure ? "自动回滚" : "停止并等待处理"}</strong></div>
        <div><span>计划承诺</span><strong title={preview.previewDigest}>{shortDigest(preview.previewDigest)}</strong></div>
      </div>

      <section className="releasePlanSequence" aria-labelledby="release-plan-sequence-title">
        <div className="releaseSectionHeading">
          <div>
            <h3 id="release-plan-sequence-title">真实执行顺序</h3>
            <p>新版 Worker 桥 → 全部 API → 剩余 Worker。任何节点未恢复服务都会停止后续滚动。</p>
          </div>
          <Badge tone="info">schema-neutral</Badge>
        </div>
        <div className="releasePlanRoleGroups">
          {roleGroups.map((group) => (
            <section className={`releasePlanRoleGroup is-${group.role}`} key={group.key} aria-labelledby={`release-plan-${group.key}-title`}>
              <header>
                <div>
                  {group.role === "worker" ? <Cpu size={16} aria-hidden="true" /> : <Server size={16} aria-hidden="true" />}
                  <span><strong id={`release-plan-${group.key}-title`}>{group.title}</strong><small>{group.description}</small></span>
                </div>
                <Badge tone={group.targets.length ? "info" : "warning"}>{group.targets.length} 台</Badge>
              </header>
              {group.targets.length ? (
                <ol>{group.targets.map((target) => <PlanTarget key={target.key} target={target} index={executionTargets.indexOf(target)} />)}</ol>
              ) : (
                <Alert tone="warning">发布计划中没有{group.title}，不能视为完整平台发布。</Alert>
              )}
            </section>
          ))}
        </div>
      </section>

      <div className="releaseSafetyGrid">
        <div><ShieldCheck size={17} aria-hidden="true" /><span><strong>API 流量保护</strong>CLB 容量校验通过后才逐台摘流</span></div>
        <div><FileCheck2 size={17} aria-hidden="true" /><span><strong>Worker 任务保护</strong>停止接单且在途任务归零后才升级</span></div>
        <div><RotateCcw size={17} aria-hidden="true" /><span><strong>整组一致性</strong>所有节点精确收敛到同一制品并通过公网验证后才发布</span></div>
      </div>
    </div>
  );
}

export function ReleasePlanDialog({
  open,
  release,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  release: PlatformReleaseRecord | null;
  onOpenChange: (open: boolean) => void;
  onStarted: (deployment: ReleaseDeploymentDetail) => void;
}) {
  const [mode, setMode] = useState<ArtifactMode>("upload");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [sidecarFile, setSidecarFile] = useState<File | null>(null);
  const [sidecar, setSidecar] = useState<ReleaseArtifactSidecar | null>(null);
  const [uploadedTarget, setUploadedTarget] = useState<ReleaseArtifactUploadReceipt | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedBytes: number;
    totalBytes: number;
    completedParts: number;
    totalParts: number;
  } | null>(null);
  const uploadAbortController = useRef<AbortController | null>(null);
  const [existingArtifactId, setExistingArtifactId] = useState("");
  const [artifact, setArtifact] = useState<ReleaseArtifactRecord | null>(null);
  const [preview, setPreview] = useState<ReleaseDeploymentPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [nodeInventoryFrozen, setNodeInventoryFrozen] = useState(false);
  const [nMinusOneCapacityVerified, setNMinusOneCapacityVerified] = useState(false);
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [uploadIdempotencyKey, setUploadIdempotencyKey] = useState("");
  const [artifactIdempotencyKey, setArtifactIdempotencyKey] = useState("");
  const [deploymentIdempotencyKey, setDeploymentIdempotencyKey] = useState("");
  const [pipelineProofs, setPipelineProofs] = useState<ReleasePipelineProofs | null>(null);

  useEffect(() => {
    if (!open || !release) return;
    const checkpoint = loadReleaseArtifactMultipartCheckpoint(release.id);
    setMode("upload");
    setArchiveFile(null);
    setSidecarFile(null);
    setSidecar(null);
    setUploadedTarget(checkpoint?.status === "completed"
      ? {
          reservationId: checkpoint.reservationId,
          sessionId: checkpoint.sessionId,
        }
      : null);
    setUploadProgress(checkpoint?.status === "active"
      ? {
          uploadedBytes: 0,
          totalBytes: checkpoint.byteSize,
          completedParts: 0,
          totalParts: checkpoint.partCount,
        }
      : null);
    setExistingArtifactId("");
    setArtifact(null);
    setPreview(null);
    setAcknowledged(false);
    setErrors({});
    setActionError("");
    setBusy(null);
    setPipelineProofs(null);
    setUploadIdempotencyKey(
      checkpoint?.idempotencyKey
        || createIdempotencyKey(`artifact-upload:${release.id}`),
    );
    setArtifactIdempotencyKey(createIdempotencyKey(`artifact:${release.id}`));
    setDeploymentIdempotencyKey(createIdempotencyKey(`deployment:${release.id}`));
  }, [open, release]);

  const selectedArtifactId = mode === "existing" ? existingArtifactId.trim() : artifact?.id || "";
  const currentSection = preview ? "execute" : selectedArtifactId && (mode === "existing" || artifact?.status === "ready") ? "plan" : "artifact";
  const busyLabels = useMemo(() => ({
    upload: "正在上传并登记制品",
    register: "正在登记制品",
    verify: "正在校验制品",
    preview: "正在生成发布计划",
    start: "正在创建发布任务",
  }), []);
  const busyLabel = busy ? busyLabels[busy] : "";

  function clearError(field?: keyof RegistrationErrors) {
    setActionError("");
    if (field) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function changeMode(next: string) {
    setMode(next as ArtifactMode);
    setPreview(null);
    setAcknowledged(false);
    setPipelineProofs(null);
    setActionError("");
    setErrors({});
    setDeploymentIdempotencyKey(createIdempotencyKey(`deployment:${release?.id || "release"}`));
  }

  function resetUploadIdentity(clearCheckpoint = true) {
    if (!release) return;
    if (clearCheckpoint) clearReleaseArtifactMultipartCheckpoint(release.id);
    setUploadedTarget(null);
    setUploadProgress(null);
    setArtifact(null);
    setPreview(null);
    setAcknowledged(false);
    setPipelineProofs(null);
    setUploadIdempotencyKey(createIdempotencyKey(`artifact-upload:${release.id}`));
    setArtifactIdempotencyKey(createIdempotencyKey(`artifact:${release.id}`));
    setDeploymentIdempotencyKey(createIdempotencyKey(`deployment:${release.id}`));
  }

  async function readSidecar(file: File, archiveSize?: number) {
    if (!release) return null;
    try {
      const parsed = parseArtifactSidecarText(await file.text(), release.id, archiveSize);
      setSidecar(parsed);
      setErrors((current) => ({ ...current, sidecar: undefined }));
      return parsed;
    } catch (error) {
      setSidecar(null);
      setErrors((current) => ({ ...current, sidecar: error instanceof Error ? error.message : "sidecar 读取失败。" }));
      return null;
    }
  }

  async function selectArchive(file: File | null) {
    if (release && file) {
      const checkpoint = loadReleaseArtifactMultipartCheckpoint(release.id);
      if (checkpoint && releaseArtifactMultipartCheckpointMatchesFile(checkpoint, file)) {
        setUploadIdempotencyKey(checkpoint.idempotencyKey);
        setUploadedTarget(checkpoint.status === "completed"
          ? {
              reservationId: checkpoint.reservationId,
              sessionId: checkpoint.sessionId,
            }
          : null);
      } else {
        resetUploadIdentity();
      }
    } else {
      resetUploadIdentity();
    }
    setArchiveFile(file);
    setErrors((current) => ({ ...current, archive: undefined }));
    if (!file) return;
    if (!/\.(?:tar\.gz|tgz)$/i.test(file.name)) {
      setErrors((current) => ({ ...current, archive: "只支持 .tar.gz 或 .tgz 发布制品。" }));
      return;
    }
    if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
      setErrors((current) => ({ ...current, archive: "制品大小必须大于 0 且不超过 5 GiB。" }));
      return;
    }
    if (sidecarFile) await readSidecar(sidecarFile, file.size);
  }

  async function selectSidecar(file: File | null) {
    setSidecarFile(file);
    setSidecar(null);
    setErrors((current) => ({ ...current, sidecar: undefined }));
    if (!file) return;
    const parsed = await readSidecar(file, archiveFile?.size);
    if (!release || !archiveFile || !parsed) return;
    const checkpoint = loadReleaseArtifactMultipartCheckpoint(release.id);
    if (
      checkpoint
      && !releaseArtifactMultipartCheckpointMatchesFile(
        checkpoint,
        archiveFile,
        parsed.artifactSha256,
      )
    ) {
      resetUploadIdentity();
    }
  }

  async function uploadArtifact() {
    if (!release || busy) return;
    const nextErrors: RegistrationErrors = {};
    if (!archiveFile) {
      if (!uploadedTarget) nextErrors.archive = "请选择发布制品文件。";
    } else if (!/\.(?:tar\.gz|tgz)$/i.test(archiveFile.name) || archiveFile.size <= 0 || archiveFile.size > MAX_ARCHIVE_BYTES) {
      nextErrors.archive = "请选择不超过 5 GiB 的 .tar.gz 或 .tgz 制品。";
    }
    if (!sidecarFile || !sidecar) nextErrors.sidecar = errors.sidecar || "请选择与制品同时生成的 .json sidecar。";
    setErrors((current) => ({ ...current, ...nextErrors }));
    if ((!archiveFile && !uploadedTarget) || !sidecar || Object.keys(nextErrors).length) return;
    setBusy("upload");
    setActionError("");
    const controller = new AbortController();
    uploadAbortController.current = controller;
    try {
      const proofs = pipelineProofs || await acquireReleasePipelineProofs();
      if (!pipelineProofs) setPipelineProofs(proofs);
      const registered = uploadedTarget
        ? await registerReleaseArtifact({
            releaseId: release.id,
            reservationId: uploadedTarget.reservationId,
            sha256: sidecar.artifactSha256,
            manifest: sidecar.manifest,
            idempotencyKey: artifactIdempotencyKey,
          }, proofs.register)
        : await uploadAndRegisterReleaseArtifact({
            releaseId: release.id,
            archive: archiveFile!,
            sha256: sidecar.artifactSha256,
            manifest: sidecar.manifest,
            uploadIdempotencyKey,
            idempotencyKey: artifactIdempotencyKey,
            signal: controller.signal,
            onProgress: setUploadProgress,
            onUploaded: setUploadedTarget,
          }, proofs);
      clearReleaseArtifactMultipartCheckpoint(release.id);
      setUploadProgress(null);
      setArtifact(registered);
    } catch (error) {
      setActionError(controller.signal.aborted
        ? "已停止本次上传。若选择了中止会话，请重新开始。"
        : error instanceof Error
          ? error.message
          : "制品上传或登记失败，请重试。");
    } finally {
      if (uploadAbortController.current === controller) {
        uploadAbortController.current = null;
      }
      setBusy(null);
    }
  }

  async function cancelUpload() {
    if (!release) return;
    uploadAbortController.current?.abort(
      new DOMException("操作人已停止上传", "AbortError"),
    );
    const checkpoint = loadReleaseArtifactMultipartCheckpoint(release.id);
    if (!checkpoint) return;
    try {
      await abortReleaseArtifactMultipart(checkpoint);
      resetUploadIdentity(false);
    } catch (error) {
      setActionError(error instanceof Error
        ? error.message
        : "中止远端上传会话失败，请稍后重试。");
    }
  }

  async function verifyArtifact() {
    if (!artifact || busy) return;
    setBusy("verify");
    setActionError("");
    try {
      setArtifact(await markReleaseArtifactReady(artifact, pipelineProofs?.verify));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "制品校验失败，请重试。");
    } finally {
      setBusy(null);
    }
  }

  async function createPreview() {
    if (!release || busy) return;
    const artifactId = selectedArtifactId;
    if (!isUuid(artifactId)) {
      setErrors((current) => ({ ...current, artifactId: "请输入有效的制品 ID。" }));
      return;
    }
    setBusy("preview");
    setActionError("");
    try {
      const nextPreview = await previewReleaseDeployment({
        releaseId: release.id,
        releaseRevision: release.revision,
        artifactId,
      });
      setPreview(nextPreview);
      setAcknowledged(false);
      setNodeInventoryFrozen(false);
      setNMinusOneCapacityVerified(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "发布计划生成失败，请检查制品状态。");
    } finally {
      setBusy(null);
    }
  }

  async function startDeployment() {
    if (!release || !preview || !releaseSafetyGateSatisfied || busy) return;
    setBusy("start");
    setActionError("");
    try {
      const deployment = await startReleaseDeployment({
        releaseId: release.id,
        releaseRevision: preview.releaseRevision,
        artifactId: preview.artifactId,
        targetKeys: preview.plan.targets.map((target) => target.key),
        idempotencyKey: deploymentIdempotencyKey,
        previewDigest: preview.previewDigest,
      }, pipelineProofs?.start);
      onStarted(deployment);
    } catch (error) {
      if (shouldClearReleasePreview(error)) {
        setPreview(null);
        setAcknowledged(false);
        setNodeInventoryFrozen(false);
        setNMinusOneCapacityVerified(false);
        setDeploymentIdempotencyKey(createIdempotencyKey(`deployment:${release.id}`));
        setActionError(
          `${error instanceof Error ? error.message : "发布计划已变化。"} 已清除原确认，请重新生成并核对滚动计划。`,
        );
      } else {
        setActionError(error instanceof Error ? error.message : "发布任务创建失败，请重试。");
      }
    } finally {
      setBusy(null);
    }
  }

  function resetArtifact() {
    if (!release) return;
    clearReleaseArtifactMultipartCheckpoint(release.id);
    setArchiveFile(null);
    setSidecarFile(null);
    setSidecar(null);
    setUploadedTarget(null);
    setUploadProgress(null);
    setArtifact(null);
    setPreview(null);
    setAcknowledged(false);
    setNodeInventoryFrozen(false);
    setNMinusOneCapacityVerified(false);
    setActionError("");
    setPipelineProofs(null);
    setUploadIdempotencyKey(createIdempotencyKey(`artifact-upload:${release.id}`));
    setArtifactIdempotencyKey(createIdempotencyKey(`artifact:${release.id}`));
    setDeploymentIdempotencyKey(createIdempotencyKey(`deployment:${release.id}`));
  }

  const canPreview = mode === "existing" ? isUuid(existingArtifactId) : artifact?.status === "ready";
  const releaseSafetyGateSatisfied = isReleaseSafetyGateSatisfied({
    artifactAndRollback: acknowledged,
    nodeInventoryFrozen,
    nMinusOneCapacityVerified,
  });

  return (
    <Dialog
      open={open}
      title={release ? `发布 ${release.version}` : "正式发布"}
      description="登记已构建制品，核对逐台升级顺序，再启动生产环境滚动发布。"
      size="xl"
      loading={Boolean(busy)}
      onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}
      contentClassName="releasePlanDialogContent"
      footer={({ requestClose, pending }) => (
        <div className="releasePlanDialogFooter">
          <div aria-live="polite">
            {actionError ? <Alert tone="danger">{actionError}</Alert> : busyLabel ? <span className="releaseBusyLabel">{busyLabel}</span> : null}
          </div>
          <div>
            <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
            {!preview ? (
              <Button
                icon={<ServerCog size={16} />}
                disabled={!canPreview || Boolean(busy)}
                loading={busy === "preview"}
                onClick={() => void createPreview()}
              >
                生成滚动计划
              </Button>
            ) : (
              <Button
                icon={<ShieldCheck size={16} />}
                disabled={!releaseSafetyGateSatisfied || Boolean(busy)}
                loading={busy === "start"}
                onClick={() => void startDeployment()}
              >
                确认并一键发布
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="releasePlanDialog">
        <nav className="releasePlanSteps" aria-label="发布准备进度">
          {[
            ["artifact", "制品"],
            ["plan", "滚动计划"],
            ["execute", "执行"],
          ].map(([value, label]) => (
            <span key={value} className={currentSection === value ? "is-current" : preview || value === "artifact" || (value === "plan" && currentSection === "execute") ? "is-complete" : ""}>
              {value !== currentSection && (preview || value === "artifact") ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
              {label}
            </span>
          ))}
        </nav>

        <Alert tone="warning">
          当前仅允许不包含数据库结构变更的 schema-neutral 制品。一键发布会先建立一台新版 Worker 兼容桥，再逐台摘流升级 API，最后逐台排空并升级剩余 Worker。全部节点精确验活且公网检查通过后，版本才正式发布；任一节点失败都会停止后续升级并尝试安全回切。
        </Alert>

        {!preview ? (
          <section className="releaseArtifactSection" aria-labelledby="release-artifact-title">
            <div className="releaseSectionHeading">
              <div>
                <h3 id="release-artifact-title">发布制品</h3>
                <p>制品必须已上传至私有 TOS，服务器只下载并校验这一个不可变文件。</p>
              </div>
              {artifact ? <Button size="compact" variant="ghost" onClick={resetArtifact}>重新登记</Button> : null}
            </div>

            {!artifact ? (
              <>
                <Tabs
                  ariaLabel="选择发布制品来源"
                  value={mode}
                  onValueChange={changeMode}
                  items={[
                    { value: "upload", label: "本地上传" },
                    { value: "existing", label: "使用已登记制品" },
                  ]}
                />
                {mode === "upload" ? (
                  <div className="releaseArtifactForm">
                    <div className="releaseUploadPickerGrid">
                      <FormField label="发布制品" required optionalLabel={null} error={errors.archive} help="选择 CI 生成的 .tar.gz 或 .tgz 文件，最大 5 GiB。">
                        <label className="releaseFilePicker">
                          <input type="file" accept=".tar.gz,.tgz,application/gzip" onChange={(event) => void selectArchive(event.target.files?.[0] || null)} />
                          <span>{archiveFile ? archiveFile.name : "选择制品文件"}</span>
                          <small>{archiveFile ? formatBytes(archiveFile.size) : "TOS 私有直传"}</small>
                        </label>
                      </FormField>
                      <FormField label="制品 sidecar" required optionalLabel={null} error={errors.sidecar} help="选择构建脚本生成的同名 .json 文件。">
                        <label className="releaseFilePicker">
                          <input type="file" accept=".json,application/json" onChange={(event) => void selectSidecar(event.target.files?.[0] || null)} />
                          <span>{sidecarFile ? sidecarFile.name : "选择 sidecar"}</span>
                          <small>{sidecar ? `SHA-256 ${shortDigest(sidecar.artifactSha256)}` : "自动读取摘要与 Manifest"}</small>
                        </label>
                      </FormField>
                    </div>
                    {uploadedTarget ? (
                      <Alert tone="info">制品分片已全部上传。如果登记响应中断，将安全复用原预约重试。</Alert>
                    ) : uploadProgress ? (
                      <Alert tone="info">
                        检测到可恢复的分片上传。刷新或重启浏览器后，重新选择同一制品即可跳过已完成分片。
                      </Alert>
                    ) : null}
                    {uploadProgress ? (
                      <div className="releaseMultipartProgress" aria-live="polite">
                        <progress value={uploadProgress.uploadedBytes} max={Math.max(1, uploadProgress.totalBytes)} />
                        <span>
                          {formatBytes(uploadProgress.uploadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                          {` · ${uploadProgress.completedParts}/${uploadProgress.totalParts} 分片`}
                        </span>
                      </div>
                    ) : null}
                    <div className="releaseArtifactActions">
                      <Button variant="secondary" loading={busy === "upload"} disabled={Boolean(busy) || (!uploadedTarget && !archiveFile) || !sidecar} onClick={() => void uploadArtifact()}>
                        {uploadedTarget ? "重试登记" : uploadProgress ? "继续上传并登记" : "上传并登记"}
                      </Button>
                      {busy === "upload" ? (
                        <Button variant="ghost" onClick={() => void cancelUpload()}>停止并中止会话</Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="releaseExistingArtifact">
                    <FormField label="制品 ID" required optionalLabel={null} error={errors.artifactId} help="只接受已完成服务端校验且属于当前版本草稿的制品。">
                      <Input value={existingArtifactId} onChange={(event) => { setExistingArtifactId(event.target.value); clearError("artifactId"); }} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                    </FormField>
                  </div>
                )}
              </>
            ) : (
              <>
                <ArtifactSummary artifact={artifact} />
                {artifact.status === "registered" ? (
                  <div className="releaseArtifactVerification">
                    <div>
                      <strong>等待服务端校验</strong>
                      <span>确认 TOS 对象、SHA-256 和 Manifest 与交付制品一致。</span>
                    </div>
                    <Button loading={busy === "verify"} disabled={Boolean(busy)} onClick={() => void verifyArtifact()}>校验制品</Button>
                  </div>
                ) : artifact.status === "rejected" ? (
                  <Alert tone="danger">{artifact.rejectionReason || "制品未通过校验，请重新登记。"}</Alert>
                ) : (
                  <Alert tone="success">制品校验通过，可以生成生产环境滚动发布计划。</Alert>
                )}
              </>
            )}
          </section>
        ) : (
          <>
            {artifact ? <ArtifactSummary artifact={artifact} /> : (
              <div className="releaseExistingArtifactSummary">
                <FileCheck2 size={18} aria-hidden="true" />
                <div><strong>已登记制品</strong><span>{preview.artifactId}</span></div>
                <Badge tone="success">校验通过</Badge>
              </div>
            )}
            <PlanPreview preview={preview} />
            <section className="releasePlanAcknowledgements" aria-label="生产发布前确认">
              <label className="releasePlanAcknowledgement">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>
                  <strong>我已核对制品、API 与 Worker 升级顺序</strong>
                  <small>确认本制品不包含数据库结构变更，并允许任一节点失败时自动回滚到上一版本。</small>
                </span>
              </label>
              <label className="releasePlanAcknowledgement">
                <input type="checkbox" checked={nodeInventoryFrozen} onChange={(event) => setNodeInventoryFrozen(event.target.checked)} />
                <span>
                  <strong>节点清单已冻结</strong>
                  <small>确认 API 与 Worker ASG 已暂停自动扩缩容，发布窗口内不会新增、替换或缩减节点。</small>
                </span>
              </label>
              <label className="releasePlanAcknowledgement">
                <input type="checkbox" checked={nMinusOneCapacityVerified} onChange={(event) => setNMinusOneCapacityVerified(event.target.checked)} />
                <span>
                  <strong>N-1 峰值容量已验证</strong>
                  <small>确认摘除任意一台 API 或 Worker 后，剩余节点仍可承接完整业务峰值并保有安全余量。</small>
                </span>
              </label>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
