import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/http";
import { formatGuMicros, guMicrosFromGu } from "../../utils/billingUnits";
import { getAgentProjectBudget, updateAgentProjectBudget, type AgentProjectBudget } from "./budgetApi";

type AgentBudgetSectionProps = {
  projectId: number | string;
};

/**
 * 预算自主审批设置区块(项目设定页内一栏,不新造页面)。
 *
 * 体验契约:项目未设预算时 R2 审批逐次弹确认卡;设置预算且服务端灰度开启后,
 * 预留+报价最高额 ≤ 预算 的 R2 审批由服务端同事务自动批准,对话里不再出现待
 * 操作确认卡(只回显一张"预算内自动批准"的只读记录);超额自动回落人工确认卡。
 */
export default function AgentBudgetSection({ projectId }: AgentBudgetSectionProps) {
  const [budget, setBudget] = useState<AgentProjectBudget | null>(null);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getAgentProjectBudget(projectId);
      setBudget(next);
      setUnavailable(false);
      return next;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) {
        // Agent Runtime 未开放或无权限时静默降级:不影响项目设定页其它内容。
        setUnavailable(true);
      } else {
        setMessage(error instanceof Error ? error.message : "预算读取失败");
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    setBudget(null);
    setEditing(false);
    setMessage("");
    void load();
  }, [load]);

  async function save(valueMicros: number | null) {
    setSaving(true);
    setMessage("");
    try {
      const next = await updateAgentProjectBudget(projectId, valueMicros);
      setBudget(next);
      setEditing(false);
      setMessage(valueMicros === null ? "已清除预算:R2 审批恢复逐次人工确认。" : "预算已保存:额度内的费用审批将自动通过(以服务端灰度为准)。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "预算保存失败");
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    const text = input.trim();
    if (!text) {
      void save(null);
      return;
    }
    const gu = Number(text);
    if (!Number.isFinite(gu) || gu <= 0 || guMicrosFromGu(gu) > Number.MAX_SAFE_INTEGER) {
      setMessage("请输入大于 0 的 GU 数量;留空保存即清除预算。");
      return;
    }
    void save(guMicrosFromGu(gu));
  }

  if (unavailable) return null;

  return (
    <div style={{ padding: 12, borderRadius: 8, border: "1px solid #e4e4e7", background: "#fafafa" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: "#71717a" }}>Agent 预算(自动批准)</div>
        {!loading && !editing ? (
          <button
            onClick={() => {
              setEditing(true);
              setInput(budget?.agentBudgetMicros != null ? String(budget.agentBudgetMicros / GU_MICROS_PER_GU) : "");
              setMessage("");
            }}
            style={{ padding: "2px 10px", borderRadius: 4, border: "1px solid #d4d4d8", background: "#fff", color: "#3f3f46", cursor: "pointer", fontSize: 12 }}
          >
            {budget?.agentBudgetMicros != null ? "调整" : "设置"}
          </button>
        ) : null}
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>读取中…</div>
      ) : editing ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="预算上限(GU),留空即清除"
            type="number"
            min="0"
            step="any"
            disabled={saving}
            style={{ flex: 1, padding: 6, border: "1px solid #e4e4e7", borderRadius: 4, fontSize: 14, color: "#18181b", outline: "none" }}
          />
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#5d94bd", color: "#fff", cursor: "pointer", fontSize: 13 }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            onClick={() => { setEditing(false); setMessage(""); }}
            disabled={saving}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d4d4d8", background: "#fff", color: "#3f3f46", cursor: "pointer", fontSize: 13 }}
          >
            取消
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 14, color: "#18181b", lineHeight: 1.6 }}>
          {budget?.agentBudgetMicros != null ? (
            <>
              <div>预算上限 <strong>{formatGuMicros(budget.agentBudgetMicros)}</strong>,当前预留占用 {formatGuMicros(budget.agentBudgetReservedMicros)}。</div>
              <div style={{ fontSize: 12, color: "#71717a" }}>
                {budget.autoApproveEnabled
                  ? "额度内的费用审批将自动批准,不再弹出确认卡;超出预算仍转人工确认。"
                  : "服务端自动批准灰度当前关闭,审批仍全部走人工确认卡。"}
              </div>
            </>
          ) : (
            <div style={{ color: "#71717a" }}>未设置预算:Agent 的费用审批逐次弹出确认卡,由你人工批准。</div>
          )}
        </div>
      )}

      {message ? <div style={{ marginTop: 6, fontSize: 12, color: "#71717a" }} role="status">{message}</div> : null}
    </div>
  );
}
