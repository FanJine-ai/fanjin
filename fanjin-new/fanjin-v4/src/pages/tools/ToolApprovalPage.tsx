import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../api/http";
import "./ToolApprovalPage.css";
type Review = { approvalId: string; status: string; workspaceId: string; expiresAt: number; quote: { quoteId: string; maximum: { gu: string }; request: { projectId: number; type: string; modelId: string; prompt: string; resolution: string; aspectRatio: string; duration?: number; audio?: boolean; mode?: string; count: number; references: Array<{ assetVersionId: string; role: string }> } } };
export default function ToolApprovalPage() {
  const { approvalId } = useParams();
  const submitting = useRef(false);
  const currentId = useRef(approvalId); currentId.current = approvalId;
  const [now, setNow] = useState(Date.now);
  const [review, setReview] = useState<Review | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); setReview(null); setError("");
    apiGet<Review>(`/tool-approvals/${approvalId}`, undefined, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setReview(value); }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [approvalId]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review?.expiresAt]);
  async function decide(decision: "approved" | "rejected") {
    if (!review || submitting.current || review.status !== "pending" || review.expiresAt <= Date.now()) return; submitting.current = true; setBusy(true); setError("");
    try { const result = await apiPost<{ status: string }>(`/tool-approvals/${approvalId}`, { decision, quoteId: review.quote.quoteId }); if (currentId.current === approvalId) setReview({ ...review, status: result.status }); }
    catch (e) { if (currentId.current === approvalId) setError(e instanceof Error ? e.message : "确认失败，请重试"); }
    finally { submitting.current = false; setBusy(false); }
  }
  const r = review?.quote.request;
  const active = review?.status === "pending" && review.expiresAt > now;
  return <main className="toolApprovalPage">
    <h1>确认生成预算</h1><p>核对本次 CLI / MCP 请求。批准后，绑定的工具可以提交一次生成；实际扣费以账本结算为准。</p>
    {error && <p role="alert">{error}</p>}
    {!review && !error && <p role="status">正在读取请求…</p>}
    {review && r && <>
      <dl><dt>工作区 / 项目</dt><dd>{review.workspaceId} / {r.projectId}</dd><dt>模型</dt><dd>{r.modelId}</dd>
        <dt>生成内容</dt><dd>{r.type === "video" ? `视频 · ${r.duration === -1 ? "自动时长" : `${r.duration} 秒`}` : `图片 · ${r.count} 张`} · {r.resolution} · {r.aspectRatio}</dd>
        {r.type === "video" && <><dt>音频 / 模式</dt><dd>{r.audio ? "生成音频" : "无音频"} / {r.mode || "默认"}</dd></>}
        <dt>最高扣费</dt><dd><strong>{review.quote.maximum.gu} GU</strong></dd><dt>授权有效期</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd>
        <dt>提示词</dt><dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.prompt}</dd>
        <dt>参考素材版本</dt><dd>{r.references.length ? r.references.map(x => `${x.assetVersionId} (${x.role})`).join("、") : "无"}</dd>
      </dl>
      {active ? <div className="toolApprovalActions"><button className="toolApprovalPrimary" disabled={busy} onClick={() => decide("approved")}>批准本次生成，最高 {review.quote.maximum.gu} GU</button>{" "}<button disabled={busy} onClick={() => decide("rejected")}>拒绝</button></div>
        : <p role="status">{({ approved: "已批准，可返回工具提交。", rejected: "已拒绝。", consumed: "已提交，请返回工具查询任务。", expired: "报价已过期，请重新报价。" } as Record<string, string>)[review.status] || "报价已过期，请重新报价。"}</p>}
    </>}
  </main>;
}
