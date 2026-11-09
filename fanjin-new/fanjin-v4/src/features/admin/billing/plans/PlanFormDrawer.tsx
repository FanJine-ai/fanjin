import { useMemo, useRef } from "react";
import { Save } from "lucide-react";
import {
  Alert,
  Button,
  Drawer,
  FieldGroup,
  FormGrid,
  FormField,
  Input,
  NumberInput,
  Select,
} from "../../../../ui/console";
import type { BillingPlanForm, BillingPlanStatus } from "./types";

interface PlanFormDrawerProps {
  open: boolean;
  form: BillingPlanForm;
  initialForm: BillingPlanForm;
  saving: boolean;
  error: string;
  onChange: (form: BillingPlanForm) => void;
  onSave: () => void;
  onOpenChange: (open: boolean) => void;
}

export function PlanFormDrawer({
  open,
  form,
  initialForm,
  saving,
  error,
  onChange,
  onSave,
  onOpenChange,
}: PlanFormDrawerProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initialForm), [form, initialForm]);
  const update = <Key extends keyof BillingPlanForm>(key: Key, value: BillingPlanForm[Key]) => {
    onChange({ ...form, [key]: value });
  };

  return (
    <Drawer
      open={open}
      className="billingPlanDrawer"
      title={form.id ? "编辑套餐" : "新建套餐"}
      description="按基本信息、价格额度、权益限制和上架状态分组维护。"
      size="min(760px, 100vw)"
      dirty={dirty}
      loading={saving}
      initialFocusRef={nameRef}
      onOpenChange={onOpenChange}
      footer={
        <div className="planDrawerActions">
          <Button
            type="submit"
            form="billing-plan-form"
            icon={<Save size={17} />}
            loading={saving}
            disabled={!form.code.trim() || !form.name.trim()}
          >
            保存套餐
          </Button>
        </div>
      }
    >
      <form
        id="billing-plan-form"
        className="planForm"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        {error && <Alert tone="danger" title="套餐保存失败">{error}</Alert>}

        <FieldGroup variant="section" legend="基本信息" description="套餐标识用于接口、计费和权限映射，创建后不可编辑。">
          <FormGrid>
            <FormField label="套餐标识" required optionalLabel={null} help={form.id ? "已创建套餐的标识不可修改。" : "建议使用简短的小写英文标识。"}>
              <Input value={form.code} disabled={Boolean(form.id)} autoCapitalize="off" autoCorrect="off" placeholder="pro" onChange={(event) => update("code", event.currentTarget.value)} />
            </FormField>
            <FormField label="套餐名称" required optionalLabel={null}>
              <Input ref={nameRef} value={form.name} placeholder="专业版" onChange={(event) => update("name", event.currentTarget.value)} />
            </FormField>
          </FormGrid>
        </FieldGroup>

        <FieldGroup variant="section" legend="价格额度" description="价格和包含额度统一使用 GU，保存时继续转换为 micros。">
          <FormGrid>
            <FormField label="月费（GU）" required optionalLabel={null}>
              <NumberInput value={form.monthlyFee} min={0} step={0.01} onValueChange={(value) => update("monthlyFee", value ?? 0)} />
            </FormField>
            <FormField label="包含额度（GU）" required optionalLabel={null}>
              <NumberInput value={form.includedCredits} min={0} step={0.01} onValueChange={(value) => update("includedCredits", value ?? 0)} />
            </FormField>
          </FormGrid>
        </FieldGroup>

        <FieldGroup variant="section" legend="权益限制" description="留空代表不限；所有限制字段仅接受非负整数。">
          <FormGrid columns={3}>
            <FormField label="API 配额" help="留空代表不限。">
              <NumberInput value={form.apiQuota} min={0} step={1} onValueChange={(value) => update("apiQuota", value)} />
            </FormField>
            <FormField label="成员上限" help="留空代表不限。">
              <NumberInput value={form.memberLimit} min={0} step={1} onValueChange={(value) => update("memberLimit", value)} />
            </FormField>
            <FormField label="密钥上限" help="留空代表不限。">
              <NumberInput value={form.keyLimit} min={0} step={1} onValueChange={(value) => update("keyLimit", value)} />
            </FormField>
          </FormGrid>
        </FieldGroup>

        <FieldGroup variant="section" legend="上架状态" description="归档套餐不会作为新的购买选项展示，但历史订阅数据仍保留。">
          <FormField label="状态" required optionalLabel={null}>
            <Select value={form.status} onChange={(event) => update("status", event.currentTarget.value as BillingPlanStatus)}>
              <option value="active">在售</option>
              <option value="archived">已归档</option>
            </Select>
          </FormField>
        </FieldGroup>
      </form>
    </Drawer>
  );
}
