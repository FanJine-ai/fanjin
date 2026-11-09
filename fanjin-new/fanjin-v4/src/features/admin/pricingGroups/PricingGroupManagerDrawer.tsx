import { useEffect, useMemo, useState } from "react";
import { Edit3, Plus, Save, Trash2, UserRoundCog } from "lucide-react";
import { toApiErrorView } from "../../../api/http";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  FieldGroup,
  FormField,
  Input,
  NumberInput,
  Select,
  useToast,
} from "../../../ui/console";
import {
  assignUsersToPricingGroup,
  createPricingGroup,
  deletePricingGroup,
  updatePricingGroup,
} from "./api";
import type { PricingGroup, PricingGroupDraft } from "./types";
import "./pricingGroups.css";

const emptyDraft = (): PricingGroupDraft => ({
  code: "",
  name: "",
  description: "",
  status: "active",
  sortOrder: 0,
});

export function PricingGroupManagerDrawer({
  open,
  groups,
  loading,
  error,
  selectedUserIds = [],
  onClose,
  onReload,
  onUsersAssigned,
}: {
  open: boolean;
  groups: PricingGroup[];
  loading: boolean;
  error: string;
  selectedUserIds?: number[];
  onClose: () => void;
  onReload: () => Promise<void>;
  onUsersAssigned?: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [draft, setDraft] = useState<PricingGroupDraft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PricingGroup | null>(null);
  const [assignmentCode, setAssignmentCode] = useState("default");
  const activeGroups = useMemo(() => groups.filter((group) => group.status === "active"), [groups]);

  useEffect(() => {
    if (!open) return;
    setEditingCode(null);
    setDraft(emptyDraft());
    setMutationError("");
    setAssignmentCode("default");
  }, [open]);

  function edit(group: PricingGroup) {
    setEditingCode(group.code);
    setDraft({
      code: group.code,
      name: group.name,
      description: group.description || "",
      status: group.status,
      sortOrder: group.sortOrder,
    });
    setMutationError("");
  }

  function resetDraft() {
    setEditingCode(null);
    setDraft(emptyDraft());
    setMutationError("");
  }

  async function save() {
    if (!draft.code.trim() || !draft.name.trim()) {
      setMutationError("请填写分组代码和显示名称。");
      return;
    }
    setSaving(true);
    setMutationError("");
    try {
      if (editingCode) await updatePricingGroup({ ...draft, code: editingCode });
      else await createPricingGroup({
        code: draft.code.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        sortOrder: draft.sortOrder,
      });
      await onReload();
      toast({ title: editingCode ? "分组已更新" : "分组已创建", message: draft.name, tone: "success" });
      resetDraft();
    } catch (caught) {
      setMutationError(toApiErrorView(caught).message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deletePricingGroup(deleteTarget.code);
      await onReload();
      toast({ title: "分组已删除", message: deleteTarget.name, tone: "success" });
      setDeleteTarget(null);
    } finally {
      setSaving(false);
    }
  }

  async function assignSelectedUsers() {
    if (!selectedUserIds.length) return;
    setSaving(true);
    setMutationError("");
    try {
      await assignUsersToPricingGroup(selectedUserIds, assignmentCode);
      await Promise.all([onReload(), Promise.resolve(onUsersAssigned?.())]);
      toast({ title: "用户分组已更新", message: `已归组 ${selectedUserIds.length} 个用户`, tone: "success" });
    } catch (caught) {
      setMutationError(toApiErrorView(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Drawer
        open={open}
        title="定价分组管理"
        description="统一创建分组、查看用户与发布目标引用，并为用户批量归组。"
        size="min(920px, 100vw)"
        loading={saving || loading}
        onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      >
        <div className="pricingGroupManager">
          {error ? <Alert tone="danger" title="分组读取失败">{error}</Alert> : null}
          {mutationError ? <Alert tone="danger">{mutationError}</Alert> : null}
          {selectedUserIds.length ? (
            <FieldGroup legend={`批量归组 · ${selectedUserIds.length} 个用户`} description="每个付款账户只能属于一个定价分组；选择默认分组会清除自定义归组。" variant="section">
              <div className="pricingGroupAssignment">
                <Select aria-label="批量归入定价分组" value={assignmentCode} onChange={(event) => setAssignmentCode(event.currentTarget.value)}>
                  {activeGroups.map((group) => <option key={group.code} value={group.code}>{group.name} · {group.code}</option>)}
                </Select>
                <Button icon={<UserRoundCog size={16} />} loading={saving} onClick={() => void assignSelectedUsers()}>应用到所选用户</Button>
              </div>
            </FieldGroup>
          ) : null}
          <FieldGroup legend={editingCode ? `编辑分组 · ${editingCode}` : "创建定价分组"} description="代码创建后不可修改，避免用户归属和模型价格规则失去引用。" variant="section">
            <div className="pricingGroupForm">
              <FormField label="分组代码" required optionalLabel={null}>
                <Input value={draft.code} disabled={Boolean(editingCode)} placeholder="例如 vip、enterprise" onChange={(event) => { const code = event.currentTarget.value; setDraft((current) => ({ ...current, code })); }} />
              </FormField>
              <FormField label="显示名称" required optionalLabel={null}>
                <Input value={draft.name} placeholder="例如 VIP 客户" onChange={(event) => { const name = event.currentTarget.value; setDraft((current) => ({ ...current, name })); }} />
              </FormField>
              <FormField label="状态" required optionalLabel={null}>
                <Select value={draft.status} disabled={!editingCode} onChange={(event) => { const status = event.currentTarget.value as PricingGroupDraft["status"]; setDraft((current) => ({ ...current, status })); }}>
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </Select>
              </FormField>
              <FormField label="排序" required optionalLabel={null}>
                <NumberInput value={draft.sortOrder} min={-10_000} max={10_000} step={1} onValueChange={(value) => setDraft((current) => ({ ...current, sortOrder: Number(value || 0) }))} />
              </FormField>
              <FormField className="pricingGroupForm__wide" label="说明" optionalLabel="可选">
                <Input value={draft.description} placeholder="说明适用客户、审批依据或运营用途" onChange={(event) => { const description = event.currentTarget.value; setDraft((current) => ({ ...current, description })); }} />
              </FormField>
            </div>
            <div className="pricingGroupFormActions">
              {editingCode ? <Button variant="ghost" onClick={resetDraft}>取消编辑</Button> : null}
              <Button icon={<Save size={16} />} loading={saving} onClick={() => void save()}>{editingCode ? "保存分组" : "创建分组"}</Button>
            </div>
          </FieldGroup>
          <section className="pricingGroupList" aria-label="定价分组列表">
            <header><div><h3>全部分组</h3><p>删除与停用前必须先迁移成员；删除还要求没有发布目标引用。</p></div><Button variant="secondary" icon={<Plus size={15} />} onClick={resetDraft}>新建</Button></header>
            {groups.map((group) => (
              <article className="pricingGroupCard" key={group.code}>
                <div className="pricingGroupCard__identity"><strong>{group.name}</strong><code>{group.code}</code><span>{group.description || "暂无说明"}</span></div>
                <div className="pricingGroupCard__stats"><span><b>{group.memberCount}</b> 用户</span><span><b>{group.pricingTargetCount}</b> 发布目标</span></div>
                <Badge tone={group.status === "active" ? "success" : "neutral"}>{group.status === "active" ? "启用" : "停用"}</Badge>
                <div className="pricingGroupCard__actions">
                  <Button variant="secondary" size="compact" icon={<Edit3 size={14} />} disabled={group.isDefault} onClick={() => edit(group)}>编辑</Button>
                  <Button variant="danger" size="compact" icon={<Trash2 size={14} />} disabled={!group.canDelete} onClick={() => setDeleteTarget(group)}>删除</Button>
                </div>
              </article>
            ))}
          </section>
        </div>
      </Drawer>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除定价分组「${deleteTarget?.name || ""}」？`}
        description="只允许删除没有用户和发布目标引用的分组，删除后不能恢复。"
        confirmLabel="确认删除"
        tone="danger"
        loading={saving}
        onCancel={() => { if (!saving) setDeleteTarget(null); }}
        onConfirm={confirmDelete}
        onConfirmError={(caught) => setMutationError(toApiErrorView(caught).message)}
      />
    </>
  );
}
