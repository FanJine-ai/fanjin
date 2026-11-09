import { useEffect, useState } from "react";
import { Alert } from "../../ui/console/recipes";
import { apiPost } from "../../api/http";

export type MembershipQuote = {
  planId: string; version: string; months: number; seedanceShare: number; name: string;
  amountMicros: number; seedanceGu: number; h3Gu: number; giftValidityMonths: number; quoteHash: string;
};
type Subscription = { id: string; name: string; startsAt: number; expiresAt: number };
type ResourceLimits = { seats: number; concurrentGenerations: number; storageBytes: number };
export type MembershipState = {
  salesEnabled: boolean; authorizationEnabled: boolean; version: string;
  plans: { id: string; name: string; priceYuan: number; features: string[]; limits?: ResourceLimits }[];
  policy?: { limits: ResourceLimits; paid: boolean };
  resources?: { inventoryReady: boolean; usedBytes: number; reservedBytes: number; running: number; queued: number } | null;
  eligibleModels?: { model: string; scope: "seedance" | "h3"; resolutions: string[] }[];
  current: Subscription | null; next: Subscription[];
  balances: { permanentGu: number; seedanceGu: number; h3Gu: number; generalGiftGu: number } | null;
};
const features: Record<string, string> = {
  storyboard: "脚本策划与智能分镜", director: "3D 导演台", analysis: "逐帧分析与成片制作",
  workflow: "工作流保存与复用", rewrite: "片段重拍", shared: "团队共享与成员邀请",
  teamBudget: "团队成员预算管理", apiManagement: "API 密钥与配额管理",
};
export function normalizeMembershipQuote(value: unknown): MembershipQuote {
  const q = value as MembershipQuote | null;
  if (!q || typeof q !== "object" || typeof q.planId !== "string" || !q.planId || !q.version || !q.name
    || ![1, 3, 12].includes(q.months) || !Number.isInteger(q.seedanceShare) || q.seedanceShare < 10 || q.seedanceShare > 90 || q.seedanceShare % 5 !== 0
    || !Number.isSafeInteger(q.amountMicros) || q.amountMicros <= 0 || !Number.isSafeInteger(q.seedanceGu) || q.seedanceGu <= 0
    || !Number.isSafeInteger(q.h3Gu) || q.h3Gu <= 0 || q.giftValidityMonths !== 12 || !/^[a-f0-9]{64}$/.test(q.quoteHash)) {
    throw new Error("会员报价不完整，请重新读取后再付款");
  }
  return q;
}
export function normalizeMembershipState(value: unknown): MembershipState | null {
  if (value == null) return null;
  const s = value as MembershipState;
  const validLimits = (limits: ResourceLimits) => limits && [limits.seats, limits.concurrentGenerations, limits.storageBytes].every(n => Number.isSafeInteger(n) && n > 0);
  const validSubscription = (v: Subscription) => v && typeof v.id === "string" && typeof v.name === "string" && Number.isFinite(v.startsAt) && Number.isFinite(v.expiresAt);
  if (!s || typeof s.version !== "string" || typeof s.salesEnabled !== "boolean" || typeof s.authorizationEnabled !== "boolean"
    || !Array.isArray(s.plans) || s.plans.some(p => !p || typeof p.id !== "string" || typeof p.name !== "string" || !Number.isFinite(p.priceYuan) || !Array.isArray(p.features)
      || (p.limits !== undefined && !validLimits(p.limits)) || (s.version.endsWith("/v2") && !p.limits))
    || (s.policy !== undefined && !validLimits(s.policy.limits))
    || (s.resources != null && (typeof s.resources.inventoryReady !== "boolean"
      || [s.resources.usedBytes, s.resources.reservedBytes, s.resources.running, s.resources.queued].some(n => !Number.isSafeInteger(n) || n < 0)))
    || (s.eligibleModels !== undefined && (!Array.isArray(s.eligibleModels) || s.eligibleModels.some(m => !m || typeof m.model !== "string"
      || !["seedance", "h3"].includes(m.scope) || !Array.isArray(m.resolutions) || m.resolutions.some(r => typeof r !== "string"))))
    || (s.current !== null && !validSubscription(s.current)) || !Array.isArray(s.next) || s.next.some(v => !validSubscription(v))
    || (s.balances !== null && [s.balances?.permanentGu, s.balances?.seedanceGu, s.balances?.h3Gu, s.balances?.generalGiftGu].some(v => !Number.isFinite(v) || v < 0))) {
    throw new Error("会员状态读取失败，请稍后重试");
  }
  return s;
}

export function MembershipPanel({ state, workspaceId, canPay, submitting, onQuoteChange }: {
  state: MembershipState | null; workspaceId: string; canPay: boolean; submitting: boolean;
  onQuoteChange: (quote: MembershipQuote | null) => void;
}) {
  const [planId, setPlanId] = useState(state?.plans[0]?.id || "");
  const [months, setMonths] = useState(1);
  const [share, setShare] = useState(30);
  const [quote, setQuote] = useState<MembershipQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const enabled = !!state?.salesEnabled && !!state.authorizationEnabled && state.plans.length > 0 && state.plans.every(plan => !!plan.limits);
  useEffect(() => {
    let alive = true;
    setQuote(null); onQuoteChange(null); setError("");
    if (!enabled || !planId) return;
    setLoading(true);
    void apiPost<unknown>("/billing/membership/quote", { workspaceId, planId, months, seedanceShare: share, version: state!.version })
      .then(value => {
        if (!alive) return;
        const next = normalizeMembershipQuote(value);
        if (next.planId !== planId || next.months !== months || next.seedanceShare !== share || next.version !== state!.version) throw new Error("报价与所选方案不一致，请重新选择");
        setQuote(next); onQuoteChange(next);
      })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "会员报价暂不可用"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, planId, months, share, workspaceId, state?.version, onQuoteChange]);
  if (!state) return <p><strong>会员订阅暂未开放</strong>，通用积分可继续充值并永久保留。</p>;
  const date = (at: number) => new Date(at).toLocaleDateString("zh-CN");
  const space = (bytes: number) => bytes >= 1e12 ? `${bytes / 1e12} TB` : `${Number((bytes / 1e9).toFixed(2))} GB`;
  return <section className="rechargeMembership">
    <div className="rechargeCenterIntro"><h3>选择适合你的创作计划</h3><p>当前工作区共享会员权益，专属额度按月到账。通用充值永久有效。</p></div>
    {state.current ? <p role="status">当前：{state.current.name} · 有效至 {date(state.current.expiresAt)}</p> : <p>当前工作区暂无生效中的会员。</p>}
    {state.next.map(s => <p key={s.id}>待生效：{s.name} · {date(s.startsAt)} 至 {date(s.expiresAt)}</p>)}
    {state.balances ? <dl className="membershipBalances">{[
      ["通用永久额度", state.balances.permanentGu], ["Seedance 专属额度", state.balances.seedanceGu],
      ["H3 专属额度", state.balances.h3Gu], ["其他赠额", state.balances.generalGiftGu],
    ].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{Number(amount).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GU</dd></div>)}</dl> : null}
    {!enabled ? <p role="status">会员订阅暂未开放。已购权益和剩余额度按原有效期保留。</p> : null}
    {state.resources && state.policy ? <div className="membershipQuote" aria-label="工作区资源用量">
      <p>当前生成 {state.resources.running}/{state.policy.limits.concurrentGenerations} 个 · 排队 {state.resources.queued} 个</p>
      <p>云空间 {state.resources.inventoryReady ? space(state.resources.usedBytes) : "核对中"} / {space(state.policy.limits.storageBytes)}
        {state.resources.reservedBytes > 0 ? ` · 处理中预留 ${space(state.resources.reservedBytes)}` : ""}</p>
      <p>空间不足或会员到期后，已有作品仍可查看、下载和清理。</p>
    </div> : null}
    <div className="membershipPlanGrid" role="group" aria-label="会员档位">{state.plans.map(plan => <button
      type="button" key={plan.id} aria-pressed={plan.id === planId} disabled={!enabled || submitting} onClick={() => setPlanId(plan.id)}>
      <strong>{plan.name}</strong><span>¥{plan.priceYuan.toLocaleString("zh-CN")} / 月</span>
      {plan.limits ? <small>{plan.limits.seats} 人共享（含所有者）<br />同时生成 {plan.limits.concurrentGenerations} 个任务<br />{space(plan.limits.storageBytes)} 云空间</small> : <small>资源规格读取中，暂不可购买</small>}
    </button>)}</div>
    <div className="membershipQuote"><h4>所有会员包含</h4>
      <p>Agent、图片与视频创作、画布、{Object.values(features).join("、")}。</p>
      <p>所有档位使用相同的已开放功能，清晰度和时长由模型支持范围决定。生成按报价消耗 GU；成员仍按工作区角色操作。</p>
      <p>人数、并发、云空间及每月额度均由当前工作区共享，不按成员数翻倍。</p>
    </div>
    <fieldset className="membershipSelection" disabled={!enabled || submitting}>
      <legend>订阅周期与额度配比</legend>
      <div className="membershipPeriods" role="group" aria-label="订阅周期">{[[1, "月付"], [3, "季付"], [12, "年付"]].map(([n, label]) =>
        <button type="button" key={n} aria-pressed={months === n} onClick={() => setMonths(Number(n))}>{label}</button>)}</div>
      <label htmlFor="membership-share">Seedance {share}% / H3 {100 - share}%（GU 配比）</label>
      <input id="membership-share" type="range" min={10} max={90} step={5} value={share} onChange={event => setShare(Number(event.target.value))} />
    </fieldset>
    <div className="membershipQuote" aria-live="polite">
      {loading ? <p>正在计算报价…</p> : quote ? <>
        <p>每月到账：<strong>{quote.seedanceGu.toLocaleString("zh-CN")} GU Seedance</strong> + <strong>{quote.h3Gu.toLocaleString("zh-CN")} GU H3</strong></p>
        <p>本次支付 <strong>¥{(quote.amountMicros / 1_000_000).toLocaleString("zh-CN")}</strong>，共 {quote.months} 期。每期到账的赠额独立保留一年。</p>
      </> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p>专属额度仅用于对应模型的已开放规格；其他模型使用通用额度。新订阅接续在已购会员之后，不自动扣款。会员到期后，余额按各自有效期保留。</p>
      {state.eligibleModels?.length ? <details><summary>查看专属额度适用的模型与清晰度</summary>
        <ul>{state.eligibleModels.map(model => <li key={`${model.scope}:${model.model}`}>{model.model}：{model.resolutions.join("、")}</li>)}</ul>
        <p>用户组优惠和低价时段优惠使用通用额度，不叠加会员专属额度。</p>
      </details> : null}
      <p>仅工作区所有者可购买。退款前会核验本单所有赠额，已使用或正在使用的订单需联系财务处理。</p>
      {enabled && !canPay ? <p>当前没有可用的在线支付方式。</p> : null}
    </div>
  </section>;
}
