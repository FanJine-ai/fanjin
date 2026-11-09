import { useEffect, useState } from "react";
import { RefreshCcw, RotateCcw, ShieldAlert } from "lucide-react";
import {
  Alert,
  Button,
  Dialog,
  FormField,
} from "../../../ui/console";
import { reconcileReleaseDeployment } from "./api";
import { createIdempotencyKey } from "./releasePlan";
import type {
  ReleaseDeploymentDetail,
  ReleaseDeploymentReconciliationRecord,
  ReleaseReconciliationIntent,
} from "./types";

function shortIdentity(value: string | null | undefined) {
  if (!value) return "不可用";
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function ManualReconcileDialog({
  open,
  deployment,
  releaseVersion,
  onOpenChange,
  onRequested,
}: {
  open: boolean;
  deployment: ReleaseDeploymentDetail | null;
  releaseVersion?: string;
  onOpenChange: (open: boolean) => void;
  onRequested: (result: ReleaseDeploymentReconciliationRecord) => void;
}) {
  const [intent, setIntent] = useState<ReleaseReconciliationIntent | "">("");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [requestKey, setRequestKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIntent("");
    setReason("");
    setAcknowledged(false);
    setRequestKey("");
    setError("");
    setSubmitting(false);
  }, [open, deployment?.id]);

  const previousAvailable = Boolean(deployment?.previousArtifactId && deployment.previousReleaseId);
  const trimmedReason = reason.trim();
  const canSubmit = Boolean(
    deployment
    && intent
    && (intent !== "previous" || previousAvailable)
    && deployment.status === "degraded_manual"
    && trimmedReason.length >= 3
    && acknowledged
    && !submitting,
  );
  const selectedLabel = intent === "previous" ? "上一正式版本" : intent === "target" ? "本次目标版本" : "所选版本";

  function invalidateRequestIdentity() {
    setRequestKey("");
    setError("");
  }

  async function submit() {
    if (!deployment || !intent || !canSubmit) return;
    const idempotencyKey = requestKey || createIdempotencyKey(`reconcile:${deployment.id}`);
    if (!requestKey) setRequestKey(idempotencyKey);
    setSubmitting(true);
    setError("");
    try {
      const result = await reconcileReleaseDeployment({
        id: deployment.id,
        revision: deployment.revision,
        intent,
        reason: trimmedReason,
        idempotencyKey,
      });
      onRequested(result);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "人工收敛请求提交失败，请刷新任务状态后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="Root 人工收敛生产集群"
      description={`任务 ${deployment?.id || ""} 将由控制器重新核验全部节点。`}
      size="lg"
      loading={submitting}
      contentClassName="releaseManualReconcileDialog"
      onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen); }}
      footer={({ requestClose, pending }) => (
        <div className="releaseManualReconcileFooter">
          <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
          <Button
            variant="danger"
            icon={<ShieldAlert size={16} />}
            loading={submitting}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            请求收敛到{selectedLabel}
          </Button>
        </div>
      )}
    >
      <div className="releaseManualReconcile">
        <Alert tone="danger">
          <strong>这是生产故障收敛，不是强制解锁。</strong>
          <span>控制器只会在全部 API、Worker、制品身份和公网冒烟均通过后释放生产发布锁。任一检查不一致都会失败并继续锁定。</span>
        </Alert>

        <section aria-labelledby="release-reconcile-intent-title">
          <div className="releaseSectionHeading">
            <div>
              <h3 id="release-reconcile-intent-title">选择唯一收敛目标</h3>
              <p>必须明确选择旧版或新版，控制器不会自动猜测现场应保留的版本。</p>
            </div>
          </div>
          <div className="releaseReconcileChoices" role="radiogroup" aria-labelledby="release-reconcile-intent-title">
            <label className={`releaseReconcileChoice ${intent === "previous" ? "is-selected" : ""} ${previousAvailable ? "" : "is-disabled"}`}>
              <input
                type="radio"
                name="release-reconcile-intent"
                value="previous"
                checked={intent === "previous"}
                disabled={!previousAvailable || submitting}
                onChange={() => { setIntent("previous"); invalidateRequestIdentity(); }}
              />
              <span className="releaseReconcileChoice__icon" aria-hidden="true"><RotateCcw size={18} /></span>
              <span>
                <strong>上一正式版本（旧版）</strong>
                <small>把所有 API 与 Worker 收敛到上一制品，通过公网验证后将本次版本恢复为草稿。</small>
                <code>{shortIdentity(deployment?.previousArtifactId)}</code>
              </span>
            </label>
            <label className={`releaseReconcileChoice ${intent === "target" ? "is-selected" : ""}`}>
              <input
                type="radio"
                name="release-reconcile-intent"
                value="target"
                checked={intent === "target"}
                disabled={submitting}
                onChange={() => { setIntent("target"); invalidateRequestIdentity(); }}
              />
              <span className="releaseReconcileChoice__icon" aria-hidden="true"><RefreshCcw size={18} /></span>
              <span>
                <strong>本次目标版本（新版）{releaseVersion ? ` ${releaseVersion}` : ""}</strong>
                <small>把所有 API 与 Worker 收敛到本次制品，通过公网验证后将版本正式发布。</small>
                <code>{shortIdentity(deployment?.artifactId)}</code>
              </span>
            </label>
          </div>
        </section>

        <FormField
          label="处置原因与现场依据"
          required
          optionalLabel={null}
          help="原因会写入发布事件与审计日志，至少 3 个字符。"
          error={reason.length > 0 && trimmedReason.length < 3 ? "请填写至少 3 个字符。" : error || undefined}
        >
          <textarea
            rows={4}
            maxLength={500}
            value={reason}
            disabled={submitting}
            placeholder="说明为何选择该版本，以及已完成的现场核对"
            onChange={(event) => { setReason(event.target.value); invalidateRequestIdentity(); }}
          />
        </FormField>

        <label className="releaseReconcileAcknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={submitting}
            onChange={(event) => { setAcknowledged(event.target.checked); setError(""); }}
          />
          <span>
            <strong>我确认由 Root 执行，并将完成 MFA 二次验证</strong>
            <small>请求入队后仍保持生产锁。只有控制器完成全量收敛和公网验证，锁才会释放。</small>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
