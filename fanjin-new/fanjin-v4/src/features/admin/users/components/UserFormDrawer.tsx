import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Save } from "lucide-react";
import {
  Alert,
  Button,
  Drawer,
  FieldGroup,
  FormField,
  IconButton,
  Input,
  NumberInput,
  Select,
} from "../../../../ui/console";
import {
  accountTypeLabels,
  accountTypeOptions,
  billingModeLabels,
  billingModeOptions,
  settlementTypeLabels,
  settlementTypeOptions,
  userRoleLabels,
  userRoleOptions,
  userStatusLabels,
  userStatusOptions,
  type UserFormState,
} from "../types";
import type { PricingGroup } from "../../pricingGroups/types";

type FieldErrors = Partial<Record<keyof UserFormState, string>>;

function validate(form: UserFormState, mode: "create" | "edit") {
  const errors: FieldErrors = {};
  if (mode === "create" && form.name.trim().length < 2) errors.name = "用户名至少 2 个字符";
  if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = "请输入有效邮箱地址";
  if (mode === "create") {
    if (form.password.length < 10) errors.password = "密码至少 10 位";
    else if (!/[A-Z]/.test(form.password) || !/[a-z]/.test(form.password) || !/[0-9]/.test(form.password)) errors.password = "密码必须同时包含大写字母、小写字母和数字";
    if (form.confirmPassword !== form.password) errors.confirmPassword = "两次输入的密码不一致";
  }
  if (!form.commercialGroup.trim()) errors.commercialGroup = "商业分组不能为空";
  if (!Number.isInteger(form.rechargeDiscountBps) || form.rechargeDiscountBps < 1 || form.rechargeDiscountBps > 10000) {
    errors.rechargeDiscountBps = "折扣基点必须是 1-10000 的整数";
  }
  return errors;
}

export function UserFormDrawer({
  open,
  mode,
  initialValue,
  actorIsRoot,
  loading,
  pricingGroups,
  pricingGroupsLoading,
  submitError,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialValue: UserFormState;
  actorIsRoot: boolean;
  loading: boolean;
  pricingGroups: PricingGroup[];
  pricingGroupsLoading: boolean;
  submitError: string;
  onClose: () => void;
  onSubmit: (form: UserFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(initialValue);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const generatedFormId = useId();
  const formId = `admin-user-form-${generatedFormId.replace(/:/g, "")}`;
  const initialKey = JSON.stringify(initialValue);

  useEffect(() => {
    if (!open) return;
    setForm(initialValue);
    setErrors({});
    setShowPassword(false);
  }, [initialKey, open]);

  const dirty = useMemo(() => JSON.stringify(form) !== initialKey, [form, initialKey]);
  const roleOptions = actorIsRoot ? userRoleOptions : userRoleOptions.filter((role) => role !== "root");
  const selectablePricingGroups = pricingGroups.filter((group) => (
    group.status === "active" || group.code === form.pricingGroup
  ));

  function update<K extends keyof UserFormState>(key: K, value: UserFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const nextErrors = validate(form, mode);
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0] as keyof UserFormState | undefined;
    if (firstError) {
      const target = formRef.current?.elements.namedItem(firstError);
      if (target instanceof HTMLElement) target.focus();
      return;
    }
    await onSubmit(form);
  }

  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <Drawer
      open={open}
      title={mode === "create" ? "创建平台用户" : `编辑用户 · ${initialValue.displayName || initialValue.name}`}
      description={mode === "create" ? "创建账号、初始工作区和商业档案。" : "修改用户资料、权限状态与商业配置。"}
      size="min(780px, 100vw)"
      initialFocusRef={initialFocusRef}
      dirty={dirty}
      loading={loading}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      footer={({ requestClose, pending }) => (
        <div className="usersDrawerFooter">
          {submitError ? <Alert tone="danger">{submitError}</Alert> : null}
          {errorCount ? <Alert tone="danger">请修正表单中的 {errorCount} 项错误。</Alert> : null}
          <div className="usersDrawerActions">
            <Button variant="secondary" disabled={pending} onClick={() => requestClose("cancel")}>取消</Button>
            <Button type="submit" form={formId} icon={<Save size={17} />} loading={loading} disabled={pending}>{mode === "create" ? "创建用户" : "保存变更"}</Button>
          </div>
        </div>
      )}
    >
      <form ref={formRef} id={formId} className="usersDrawerContent" noValidate onSubmit={(event) => void submit(event)}>
        <FieldGroup variant="section" legend="基础资料" description={mode === "create" ? "用户名创建后不可在当前管理接口中修改。" : "用户名与工作区名称为只读上下文。"}>
          <div className="usersFormGrid">
            <FormField label="用户名" required={mode === "create"} error={errors.name} optionalLabel={mode === "edit" ? "只读" : undefined}>
              <Input ref={mode === "create" ? initialFocusRef : undefined} name="name" value={form.name} disabled={mode === "edit"} onChange={(event) => update("name", event.target.value)} autoComplete="username" />
            </FormField>
            <FormField label="显示名称" optionalLabel="可选">
              <Input ref={mode === "edit" ? initialFocusRef : undefined} name="displayName" value={form.displayName} onChange={(event) => update("displayName", event.target.value)} autoComplete="name" />
            </FormField>
            <FormField label="邮箱" error={errors.email} optionalLabel="可选">
              <Input name="email" type="email" inputMode="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" />
            </FormField>
            <FormField label="工作区名称" optionalLabel={mode === "create" ? "可选" : "只读"}>
              <Input name="workspaceName" value={form.workspaceName} disabled={mode === "edit"} onChange={(event) => update("workspaceName", event.target.value)} />
            </FormField>
            {mode === "create" ? (
              <>
                <FormField label="初始密码" required error={errors.password} help="至少 10 位，包含大写字母、小写字母和数字。">
                  <Input name="password" type={showPassword ? "text" : "password"} value={form.password} onChange={(event) => update("password", event.target.value)} autoComplete="new-password" endAdornment={<IconButton aria-label={showPassword ? "隐藏密码" : "显示密码"} icon={showPassword ? <EyeOff size={16} /> : <Eye size={16} />} size="compact" onClick={() => setShowPassword((value) => !value)} />} />
                </FormField>
                <FormField label="确认密码" required error={errors.confirmPassword}>
                  <Input name="confirmPassword" type={showPassword ? "text" : "password"} value={form.confirmPassword} onChange={(event) => update("confirmPassword", event.target.value)} autoComplete="new-password" />
                </FormField>
              </>
            ) : null}
          </div>
        </FieldGroup>

        <FieldGroup variant="section" legend="角色与状态" description={mode === "create" ? "新用户由后端创建为工作区所有者和正常状态，后续可编辑调整。" : "Root 角色变更仅 Root 管理员可执行；后端会保留至少一个 Root。"}>
          <div className="usersFormGrid">
            <FormField label="平台角色">
              <Select name="role" value={form.role} disabled={mode === "create"} onChange={(event) => update("role", event.target.value as UserFormState["role"])}>
                {roleOptions.map((role) => <option key={role} value={role}>{userRoleLabels[role]}</option>)}
              </Select>
            </FormField>
            <FormField label="账户状态">
              <Select name="status" value={form.status} disabled={mode === "create"} onChange={(event) => update("status", event.target.value as UserFormState["status"])}>
                {userStatusOptions.map((status) => <option key={status} value={status}>{userStatusLabels[status]}</option>)}
              </Select>
            </FormField>
          </div>
        </FieldGroup>

        <FieldGroup variant="section" legend="商业配置" description="模型定价分组控制模型可见性和实付折扣；运营商业分组仅用于内部归属，两者互不替代。">
          <div className="usersFormGrid">
            <FormField label="账户类型" required>
              <Select name="accountType" value={form.accountType} onChange={(event) => update("accountType", event.target.value as UserFormState["accountType"])}>
                {accountTypeOptions.map((value) => <option key={value} value={value}>{accountTypeLabels[value]}</option>)}
              </Select>
            </FormField>
            <FormField label="运营商业分组" required error={errors.commercialGroup} help="内部运营归属字段，不控制模型价格、模型可见性或调用权限。">
              <Input name="commercialGroup" value={form.commercialGroup} onChange={(event) => update("commercialGroup", event.target.value)} />
            </FormField>
            <FormField label="模型定价分组" optionalLabel="可选" help="由用户管理中的定价分组中心统一创建；它决定模型可见性和实付折扣，默认分组使用公共策略。">
              <Select
                name="pricingGroup"
                value={form.pricingGroup || "default"}
                disabled={pricingGroupsLoading}
                onChange={(event) => update("pricingGroup", event.currentTarget.value === "default" ? "" : event.currentTarget.value)}
              >
                {selectablePricingGroups.map((group) => (
                  <option key={group.code} value={group.code}>{group.name} · {group.code}{group.status === "disabled" ? "（已停用）" : ""}</option>
                ))}
                {form.pricingGroup && !pricingGroups.some((group) => group.code === form.pricingGroup)
                  ? <option value={form.pricingGroup}>{form.pricingGroup}（待迁移）</option>
                  : null}
              </Select>
            </FormField>
            <FormField label="充值折扣（基点）" required error={errors.rechargeDiscountBps} help="10000 表示 100%，9500 表示 95%。">
              <NumberInput name="rechargeDiscountBps" value={form.rechargeDiscountBps} min={1} max={10000} step={100} onValueChange={(value) => update("rechargeDiscountBps", value ?? 10000)} />
            </FormField>
            <FormField label="计费模式" required>
              <Select name="billingMode" value={form.billingMode} onChange={(event) => update("billingMode", event.target.value as UserFormState["billingMode"])}>
                {billingModeOptions.map((value) => <option key={value} value={value}>{billingModeLabels[value]}</option>)}
              </Select>
            </FormField>
            <FormField label="结算方式" required>
              <Select name="settlementType" value={form.settlementType} onChange={(event) => update("settlementType", event.target.value as UserFormState["settlementType"])}>
                {settlementTypeOptions.map((value) => <option key={value} value={value}>{settlementTypeLabels[value]}</option>)}
              </Select>
            </FormField>
          </div>
          <FormField label="内部备注" optionalLabel="可选" help="最多 500 字，仅用于平台运营记录。">
            <textarea name="notes" className="usersTextArea" rows={4} maxLength={500} value={form.notes} onChange={(event) => update("notes", event.target.value)} />
          </FormField>
        </FieldGroup>
      </form>
    </Drawer>
  );
}
