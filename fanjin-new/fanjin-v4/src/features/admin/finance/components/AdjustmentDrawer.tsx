import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  FieldGroup,
  FormField,
  Input,
  Select,
  type OverlayFooterRenderProps,
} from "../../../../ui/console";
import { createAdjustment } from "../api";
import type { AccountRow, AdjustmentForm, AdjustmentOperation } from "../types";
import { decimalToMicros, formatCny, guMicrosToYuanMicros } from "../utils";
import { DetailList } from "./FinanceShared";

export const adjustmentOperationLabels: Record<AdjustmentOperation, string> = {
  recharge: "充值到账",
  deduct: "扣减额度",
  refund: "退款返还",
  credit_increase: "增加信用额度",
  credit_limit: "设置信用额度",
  gift_grant: "赠送额度",
};

const operationOptions = Object.keys(adjustmentOperationLabels) as AdjustmentOperation[];

const emptyForm: AdjustmentForm = {
  workspaceId: "",
  operation: "recharge",
  amount: "",
  description: "",
  incomeAmount: "",
  campaignName: "",
  giftExpiresAt: "",
};

type FieldErrors = Partial<Record<keyof AdjustmentForm, string>>;

function createForm(account: AccountRow | null): AdjustmentForm {
  return { ...emptyForm, workspaceId: account?.workspaceId === "-" ? "" : account?.workspaceId || "" };
}

export function AdjustmentDrawer({
  account,
  onClose,
  onCompleted,
}: {
  account: AccountRow | null;
  onClose: () => void;
  onCompleted: () => Promise<void> | void;
}) {
  const [form, setForm] = useState<AdjustmentForm>(() => createForm(account));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const incomeInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
  const idempotencyKeyRef = useRef("");
  const submittingRef = useRef(false);

  useEffect(() => {
    setForm(createForm(account));
    setErrors({});
    setFormError("");
    setConfirmOpen(false);
    submittingRef.current = false;
    idempotencyKeyRef.current = typeof globalThis.crypto?.randomUUID === "function"
      ? `finance-adjustment:${globalThis.crypto.randomUUID()}`
      : `finance-adjustment:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }, [account]);

  const initialForm = useMemo(() => createForm(account), [account]);
  const dirty = account !== null && JSON.stringify(form) !== JSON.stringify(initialForm);
  const risky = form.operation === "deduct" || form.operation === "refund";
  const parsedAmountMicros = decimalToMicros(form.amount, "GU");
  const amountMicros = parsedAmountMicros ?? 0;
  const expectedIncomeMicros = guMicrosToYuanMicros(amountMicros);
  const estimatedCny = formatCny(expectedIncomeMicros);

  function update<K extends keyof AdjustmentForm>(key: K, value: AdjustmentForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFormError("");
  }

  function validate() {
    const next: FieldErrors = {};
    if (!form.workspaceId.trim()) next.workspaceId = "请填写工作区 ID";
    if (parsedAmountMicros === null) next.amount = "请输入有效金额，最多保留 6 位小数";
    else if (form.operation !== "credit_limit" && amountMicros <= 0) next.amount = "调账金额必须大于 0";
    else if (form.operation === "credit_limit" && !form.amount.trim()) next.amount = "目标信用额度必须大于或等于 0";
    if (form.description.trim().length < 2) next.description = "调账说明至少 2 个字符";
    else if (form.description.trim().length > 300) next.description = "调账说明不能超过 300 个字符";
    if (form.operation === "recharge" && form.incomeAmount.trim()) {
      const incomeMicros = decimalToMicros(form.incomeAmount);
      if (incomeMicros === null || incomeMicros <= 0) next.incomeAmount = "请输入有效收款金额，最多保留 6 位小数";
      else if (incomeMicros !== expectedIncomeMicros) next.incomeAmount = `收款金额应为 ${estimatedCny}（平台汇率 1 元 = 10 GU）`;
    }
    setErrors(next);
    const firstInvalidControl = next.workspaceId
      ? workspaceInputRef.current
      : next.amount
        ? amountInputRef.current
        : next.incomeAmount
          ? incomeInputRef.current
          : next.description
            ? descriptionInputRef.current
            : null;
    firstInvalidControl?.focus();
    return Object.keys(next).length === 0;
  }

  async function executeAdjustment() {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      await createAdjustment(form, idempotencyKeyRef.current);
      await onCompleted();
      onClose();
      return true;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "财务调账失败");
      setConfirmOpen(false);
      return false;
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  function requestSubmit() {
    if (submittingRef.current || saving) return;
    if (!validate()) return;
    if (risky) {
      setConfirmOpen(true);
      return;
    }
    void executeAdjustment();
  }

  const footer = ({ requestClose, pending }: OverlayFooterRenderProps) => (
    <div className="financeDrawerFooter">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <div className="financeDrawerActions">
        <Button variant="secondary" onClick={() => requestClose("cancel")} disabled={pending}>取消</Button>
        <Button type="submit" form="finance-adjustment-form" loading={saving} disabled={!form.workspaceId.trim() || form.description.trim().length < 2}>
          {risky ? "核对并继续" : "提交调账"}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        open={Boolean(account)}
        title="财务调账"
        description="调整会写入财务流水。请核对对象、金额与审计说明。"
        size="800px"
        loading={saving}
        dirty={dirty}
        initialFocusRef={workspaceInputRef}
        onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onClose(); }}
        footer={footer}
      >
        <form
          id="finance-adjustment-form"
          className="financeDrawerStack"
          onSubmit={(event) => {
            event.preventDefault();
            requestSubmit();
          }}
        >
          <section className="financeAdjustmentContext" aria-label="当前账户上下文">
            <div className="financeAdjustmentIdentity">
              <span>调账账户</span>
              <strong>{account?.workspaceName || "-"}</strong>
              <small>{account?.workspaceId || "未绑定工作区 ID"}</small>
            </div>
            <div>
              <span>当前余额</span>
              <strong>{account?.balance || "0 GU"}</strong>
            </div>
            <div>
              <span>信用额度</span>
              <strong>{account?.credit || "0 GU"}</strong>
            </div>
          </section>

          <FieldGroup legend="调账对象" description="确认变更所属工作区，避免跨工作区误操作。" variant="section" disabled={saving}>
            <FormField label="工作区 ID" required optionalLabel={null} error={errors.workspaceId}>
              <Input ref={workspaceInputRef} value={form.workspaceId} onChange={(event) => update("workspaceId", event.target.value)} placeholder="workspace id" />
            </FormField>
          </FieldGroup>

          <FieldGroup legend="变更内容" description="切换操作类型后，仅展示本次变更需要的字段。" variant="section" disabled={saving}>
            <div className="financeFormGrid">
              <FormField label="调账类型" required optionalLabel={null}>
                <Select value={form.operation} onChange={(event) => update("operation", event.target.value as AdjustmentOperation)}>
                  {operationOptions.map((operation) => <option key={operation} value={operation}>{adjustmentOperationLabels[operation]}</option>)}
                </Select>
              </FormField>
              <FormField
                label={form.operation === "credit_limit" ? "目标信用额度" : "调账金额"}
                required
                optionalLabel={null}
                help={`单位 GU，当前输入约合 ${estimatedCny}`}
                error={errors.amount}
              >
                <Input
                  ref={amountInputRef}
                  inputMode="decimal"
                  maxLength={32}
                  value={form.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  placeholder="例如：100"
                  endAdornment={<span>GU</span>}
                />
              </FormField>
              {form.operation === "recharge" ? (
                <FormField label="对应入账金额" help="留空时由后端按 1 元 = 10 GU 折算。" error={errors.incomeAmount}>
                  <Input
                    ref={incomeInputRef}
                    inputMode="decimal"
                    maxLength={32}
                    value={form.incomeAmount}
                    onChange={(event) => update("incomeAmount", event.target.value)}
                    placeholder="例如：0.10"
                    endAdornment={<span>人民币</span>}
                  />
                </FormField>
              ) : null}
              {form.operation === "gift_grant" ? (
                <>
                  <FormField label="活动名称">
                    <Input maxLength={120} value={form.campaignName} onChange={(event) => update("campaignName", event.target.value)} placeholder="例如：新用户赠送" />
                  </FormField>
                  <FormField label="到期时间">
                    <Input type="date" value={form.giftExpiresAt} onChange={(event) => update("giftExpiresAt", event.target.value)} />
                  </FormField>
                </>
              ) : null}
            </div>
          </FieldGroup>

          <FieldGroup legend="提交说明与摘要" description="财务操作必须留下可审计原因。" variant="section" disabled={saving}>
            <FormField label="调账说明" required optionalLabel={null} error={errors.description}>
              <textarea ref={descriptionInputRef} maxLength={300} value={form.description} onChange={(event) => update("description", event.target.value)} rows={4} placeholder="填写调账原因，至少 2 个字符" />
            </FormField>
            <div className="financeAdjustmentSummary">
              <div className="financeSummaryHeading">
                <strong>提交摘要</strong>
                <Badge tone={risky ? "danger" : "info"} icon={risky ? <AlertTriangle size={14} /> : form.operation === "recharge" ? <ArrowUpCircle size={14} /> : <ArrowDownCircle size={14} />}>
                  {risky ? "高风险操作" : "待提交"}
                </Badge>
              </div>
              <DetailList rows={[
                ["操作类型", adjustmentOperationLabels[form.operation]],
                [form.operation === "credit_limit" ? "目标额度" : "GU 变更", `${form.amount || "0"} GU`],
                ["人民币预览", form.operation === "recharge" && form.incomeAmount ? `¥${form.incomeAmount}` : estimatedCny],
                ["审计说明", form.description.trim() || "尚未填写"],
              ]} />
            </div>
          </FieldGroup>
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        title={`确认${adjustmentOperationLabels[form.operation]}`}
        description={`将对工作区 ${account?.workspaceName || form.workspaceId} 执行 ${form.amount || "0"} GU 的${adjustmentOperationLabels[form.operation]}。该操作会改变资金或退款记录并写入审计流水，请再次核对。`}
        tone="danger"
        confirmLabel={`确认${adjustmentOperationLabels[form.operation]}`}
        loading={saving}
        onCancel={() => { if (!saving) setConfirmOpen(false); }}
        onConfirm={executeAdjustment}
      />
    </>
  );
}
