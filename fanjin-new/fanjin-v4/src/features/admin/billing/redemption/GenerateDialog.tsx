import { useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import {
  Alert,
  Button,
  Dialog,
  FormField,
  FormGrid,
  Input,
  NumberInput,
} from "../../../../ui/console";
import type { RedemptionForm } from "./types";

interface GenerateDialogProps {
  open: boolean;
  form: RedemptionForm;
  initial: RedemptionForm;
  saving: boolean;
  error: string;
  onChange: (form: RedemptionForm) => void;
  onGenerate: () => void;
  onOpenChange: (open: boolean) => void;
}

export function GenerateDialog({
  open,
  form,
  initial,
  saving,
  error,
  onChange,
  onGenerate,
  onOpenChange,
}: GenerateDialogProps) {
  const amountRef = useRef<HTMLInputElement>(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const update = <Key extends keyof RedemptionForm>(key: Key, value: RedemptionForm[Key]) => {
    onChange({ ...form, [key]: value });
  };

  return (
    <Dialog
      open={open}
      className="redemptionGenerateDialog"
      title="批量生成兑换码"
      description="生成后立即展示完整结果，并同步写入批次列表。"
      size="md"
      dirty={dirty}
      loading={saving}
      initialFocusRef={amountRef}
      onOpenChange={onOpenChange}
      footer={
        <div className="redemptionDialogActions">
          <Button
            type="submit"
            form="redemption-generate-form"
            icon={<Sparkles size={17} />}
            loading={saving}
          >
            生成兑换码
          </Button>
        </div>
      }
    >
      <form
        id="redemption-generate-form"
        className="redemptionForm"
        onSubmit={(event) => {
          event.preventDefault();
          onGenerate();
        }}
      >
        {error && <Alert tone="danger" title="兑换码生成失败">{error}</Alert>}

        <FormGrid>
          <FormField label="生成数量" required optionalLabel={null} help="单批最多 1000 张。">
            <NumberInput value={form.count} min={1} max={1000} step={1} onValueChange={(value) => update("count", value ?? 1)} />
          </FormField>
          <FormField label="单张面值（GU）" required optionalLabel={null}>
            <NumberInput ref={amountRef} value={form.amountGu} min={0.01} step={0.01} onValueChange={(value) => update("amountGu", value ?? 0)} />
          </FormField>
          <FormField label="到期日期">
            <Input type="date" value={form.expiresAt} onChange={(event) => update("expiresAt", event.currentTarget.value)} />
          </FormField>
          <FormField label="批次备注">
            <Input value={form.batchNote} placeholder="例如：双十一活动" onChange={(event) => update("batchNote", event.currentTarget.value)} />
          </FormField>
        </FormGrid>
      </form>
    </Dialog>
  );
}
