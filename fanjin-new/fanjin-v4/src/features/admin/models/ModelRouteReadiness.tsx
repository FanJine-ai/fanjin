import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { Alert, Badge } from "../../../ui/console";
import type { ModelRouteReadiness, ModelRouteReadinessCheckStatus } from "./types";

const checkLabels: ReadonlyArray<readonly [keyof ModelRouteReadiness["checks"], string]> = [
  ["route", "路由状态"],
  ["channel", "通道连接"],
  ["health", "通道健康"],
  ["credential", "凭据"],
  ["adapter", "运行时 Adapter"],
  ["pricing", "GU 定价"],
  ["certification", "刊例价 / 真实任务认证"],
  ["capability", "Capability"],
  ["catalog", "目录拓扑"],
];

function checkStatusMeta(status: ModelRouteReadinessCheckStatus) {
  if (status === "pass") return { label: "通过", tone: "success" as const };
  if (status === "fail") return { label: "失败", tone: "danger" as const };
  return { label: "未检查", tone: "neutral" as const };
}

export function ModelRouteReadinessBadge({ readiness }: { readiness: ModelRouteReadiness | null }) {
  if (!readiness) return <Badge tone="neutral">未检查</Badge>;
  if (readiness.canSubmit) return <Badge tone="success">目录可提交</Badge>;
  if (readiness.productionReady) return <Badge tone="info">就绪 · 未生效</Badge>;
  return <Badge tone="danger">未就绪</Badge>;
}

export function ModelRouteReadinessPanel({ readiness }: { readiness: ModelRouteReadiness }) {
  const deliveryProofs = readiness.deliveryProofs || [];
  const tone = readiness.canSubmit ? "success" : readiness.productionReady ? "info" : "warning";
  const title = readiness.canSubmit
    ? "用户目录可提交"
    : readiness.productionReady
      ? "生产依赖已就绪，但不是当前生效路由"
      : "生产预检未通过";
  return (
    <div className="adminModelsReadiness">
      <Alert tone={tone} title={title}>
        <p>
          评估工作区 <code>{readiness.evaluatedWorkspaceId}</code>
          {readiness.resolvedChannelId ? <> · 通道 <code>{readiness.resolvedChannelId}</code></> : null}
          {readiness.resolvedProvider ? <> · {readiness.resolvedProvider}</> : null}
        </p>
        {readiness.selectionReason ? <p>{readiness.selectionReason}</p> : null}
        {readiness.reasons.length ? (
          <ul>{readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        ) : null}
      </Alert>
      <dl className="adminModelsReadinessChecks">
        {checkLabels.map(([key, label]) => {
          const check = readiness.checks[key] || {
            status: "not_checked" as const,
            reason: "当前节点尚未返回此项检查",
          };
          const meta = checkStatusMeta(check.status);
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                <Badge tone={meta.tone}>{meta.label}</Badge>
                {check.reason ? <span>{check.reason}</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>
      {deliveryProofs.length ? (
        <section className="adminModelsDeliveryProofs" aria-labelledby="adminModelsDeliveryProofsTitle">
          <div className="adminModelsDeliveryProofsHeader">
            <div>
              <h4 id="adminModelsDeliveryProofsTitle">2K / 4K 履约证明</h4>
              <p>仅展示终态资产实测结果与 GU 实际成本，不暴露供应商内部标识。</p>
            </div>
            <Badge tone="success">已验证 {deliveryProofs.length} 档</Badge>
          </div>
          <div className="adminModelsDeliveryProofGrid">
            {deliveryProofs.map((proof) => {
              const resolutionLabel = proof.resolution.toUpperCase();
              return (
                <article key={proof.operationKey} className="adminModelsDeliveryProofCard">
                  <header>
                    <strong>{resolutionLabel}</strong>
                    <Badge tone="success">已验证</Badge>
                  </header>
                  <p>已由真实任务和计费记录验证该清晰度。</p>
                  <ul aria-label={`${resolutionLabel} 交付验证项`}>
                    <li>{proof.width} × {proof.height}</li>
                    <li>{proof.videoCodec} · {Math.round(proof.bitrateBps / 1_000)} kbps</li>
                    <li>{proof.audioTrackCount > 0 ? `音轨 ${proof.audioTrackCount}` : "无音轨"}</li>
                    <li>实际成本 {proof.costMicros / GU_MICROS_PER_GU} {proof.currency}</li>
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
