import { useEffect, useState } from "react";
import { apiPost } from "../../../../api/http";
import { apiPostWithStepUp } from "../../../../api/stepUp";
import { Alert, Button, Input, Section } from "../../../../ui/console";

type Period = { id: string; workspaceId: string; paymentOrderId: string; planId: string; periodIndex: number; dueAt: number; status: string; lastError: string | null };
type State = { version: string; salesEnabled: boolean; authorizationEnabled: boolean; fundingRules: unknown[]; periods: Period[] };
export function MembershipAdmin() {
  const [state, setState] = useState<State | null>(null);
  const [rules, setRules] = useState("[]");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [pricingRuleId, setPricingRuleId] = useState("");
  const [contract, setContract] = useState("");
  async function reload() {
    const value = await apiPost<State>("/admin/billing/membership/status", {});
    setState(value); setRules(JSON.stringify(value.fundingRules, null, 2));
  }
  useEffect(() => { void reload().catch(reason => setError(reason instanceof Error ? reason.message : "会员状态读取失败")); }, []);
  async function action(run: () => Promise<unknown>, refresh = true) {
    setBusy(true); setError("");
    try { await run(); if (refresh) await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <Section title="七档工作区会员">
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {state ? <>
      <p>商品版本：{state.version}。关闭销售仍会履行已支付订单；周期发放支持幂等补发。</p>
      <label><input type="checkbox" checked={state.salesEnabled} onChange={event => setState({ ...state, salesEnabled: event.target.checked })} disabled={busy} /> 开放新购买</label>{"　"}
      <label><input type="checkbox" checked={state.authorizationEnabled} onChange={event => setState({ ...state, authorizationEnabled: event.target.checked })} disabled={busy} /> 启用统一会员与资源校验</label>
      <p>全部付费档位开放相同功能，仅席位、生成并发和包含云空间分档。开售前须完成历史素材占用核对及资源容量、成本验证。</p>
      <details style={{ marginBlock: 16 }}><summary>模型规格与成本依据</summary>
        <p>每条规则需填写 scope、model、channelId、pricingRuleId、resolutions、supplierCostBps、operatingCostBps、evidenceRef、expiresAt 和 contractHash。成本以标准 GU 面值的万分比填写，证据引用不得包含密钥。</p>
        <Input aria-label="会员通道 ID" placeholder="通道 ID" value={channelId} onChange={event => setChannelId(event.target.value)} />
        <Input aria-label="会员定价规则 ID" placeholder="定价规则 ID" value={pricingRuleId} onChange={event => setPricingRuleId(event.target.value)} />
        <Button disabled={busy || !channelId || !pricingRuleId} onClick={() => void action(async () => {
          const value = await apiPost<{ hash: string }>("/admin/billing/membership/contract", { channelId, pricingRuleId }); setContract(value.hash);
        }, false)}>读取当前配置摘要</Button>
        {contract ? <p style={{ overflowWrap: "anywhere" }}>contractHash：{contract}</p> : null}
        <textarea aria-label="会员适用规格配置" rows={12} style={{ width: "100%", fontFamily: "monospace", marginTop: 12 }} value={rules} disabled={busy} onChange={event => setRules(event.target.value)} />
        <p>开售时同时检查两类模型、成本余量和有效期；通道或价格变更后必须重新核验。单凭填写成本数值不能替代供应商账单。</p>
      </details>
      <Input aria-label="会员配置修改原因" placeholder="填写修改或补发原因（至少 8 字）" value={reason} onChange={event => setReason(event.target.value)} />
      <Button disabled={busy || reason.trim().length < 8} onClick={() => void action(() => apiPostWithStepUp("/admin/billing/membership/configure", {
        version: state.version, salesEnabled: state.salesEnabled, authorizationEnabled: state.authorizationEnabled, fundingRules: JSON.parse(rules), reason,
      }, "admin.billing.plan"))}>校验并保存会员配置</Button>
      <details style={{ marginTop: 16 }}><summary>最近 100 条发放记录</summary>
        <div style={{ overflowX: "auto" }}><table><thead><tr><th>工作区 / 订单</th><th>方案 / 期次</th><th>应发时间</th><th>状态</th><th>处理</th></tr></thead><tbody>
          {state.periods.map(period => <tr key={period.id}><td>{period.workspaceId}<br />{period.paymentOrderId}</td><td>{period.planId} / 第 {period.periodIndex + 1} 期</td>
            <td>{new Date(Number(period.dueAt)).toLocaleString("zh-CN")}</td><td>{period.status}{period.lastError ? ` · ${period.lastError}` : ""}</td>
            <td><Button disabled={busy || period.status !== "pending" || Number(period.dueAt) > Date.now() || reason.trim().length < 8}
              onClick={() => void action(() => apiPostWithStepUp("/admin/billing/membership/retry", { periodId: period.id, reason }, "admin.billing.plan"))}>重试发放</Button></td></tr>)}
        </tbody></table></div>
      </details>
    </> : <p>正在读取会员配置…</p>}
  </Section>;
}
