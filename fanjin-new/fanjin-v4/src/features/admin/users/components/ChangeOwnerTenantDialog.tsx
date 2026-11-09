import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { toApiErrorView } from "../../../../api/http";
import {
  Alert,
  Badge,
  Button,
  DescriptionList,
  Dialog,
  FieldGroup,
  FormField,
  Select,
} from "../../../../ui/console";
import { changeUserOwnerTenant, fetchUserAttribution } from "../api";
import { registrationSourceLabels, type UserAttributionDetail } from "../types";

export type TenantOption = { id: string; name: string };

export function ChangeOwnerTenantDialog(props: {
  open: boolean;
  userId: number | null;
  userName?: string;
  tenants: TenantOption[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { open, userId, userName, tenants, onClose, onChanged } = props;
  const [detail, setDetail] = useState<UserAttributionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ownerTenantId, setOwnerTenantId] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setReason("");
    setOwnerTenantId("");
    fetchUserAttribution(userId)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setOwnerTenantId(value.attribution.ownerTenantId || "");
      })
      .catch((caught) => {
        if (!cancelled) setError(toApiErrorView(caught).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const currentOwnerTenantId = detail?.attribution.ownerTenantId || "";
  const dirty = Boolean(
    detail
      && ownerTenantId
      && ownerTenantId !== currentOwnerTenantId
      && reason.trim().length >= 5,
  );

  async function submit() {
    if (!userId || !detail) return;
    setSaving(true);
    setError("");
    try {
      await changeUserOwnerTenant(userId, {
        ownerTenantId,
        expectedRevision: Number(detail.attribution.ownerTenantRevision || 0),
        reason: reason.trim(),
      });
      const refreshed = await fetchUserAttribution(userId);
      setDetail(refreshed);
      setReason("");
      setOwnerTenantId(refreshed.attribution.ownerTenantId || "");
      await onChanged();
      onClose();
    } catch (caught) {
      setError(toApiErrorView(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="修改用户所属租户"
      description={userName ? `${userName} · 仅影响运营与充值对账归属` : "仅影响运营与充值对账归属"}
      size="md"
      loading={saving}
      dirty={Boolean(reason) && dirty === false}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
          <Button
            icon={<ShieldCheck size={16} />}
            disabled={!dirty || saving || loading}
            loading={saving}
            onClick={() => void submit()}
          >
            验证并修改
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger" title="修改失败">{error}</Alert> : null}
      {loading && !detail ? <Alert tone="info">正在读取用户归属…</Alert> : null}
      {detail ? (
        <div className="usersAttributionDialog">
          <FieldGroup variant="section" legend="当前归属">
            <DescriptionList items={[
              { label: "注册租户", value: `${detail.registeredTenantName || detail.attribution.registeredTenantId}（不可修改）` },
              { label: "注册入口", value: detail.attribution.registrationHostname || "历史数据未记录" },
              {
                label: "注册来源",
                value: registrationSourceLabels[detail.attribution.registrationSource] || detail.attribution.registrationSource,
              },
              { label: "当前所属租户", value: `${detail.ownerTenantName || currentOwnerTenantId} · 版本 ${detail.attribution.ownerTenantRevision}` },
            ]} />
          </FieldGroup>
          <FieldGroup variant="section" legend="调整归属">
            <FormField label="新的所属租户" required help="仅平台管理员可修改；登录入口不会改变用户归属。">
              <Select
                aria-label="新的所属租户"
                value={ownerTenantId}
                onChange={(event) => setOwnerTenantId(event.currentTarget.value)}
              >
                <option value="">请选择租户</option>
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.id}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="修改原因" required help="5-500 字符，写入不可变审计记录。">
              <textarea
                rows={3}
                maxLength={500}
                aria-label="修改原因"
                placeholder="例如：财务确认后的运营归属调整"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
          </FieldGroup>
          <Alert tone="warning" title="此操作不会迁移任何数据">
            不会移动余额、工作区、项目、素材或历史账单；价格、模型权限与折扣仍由定价分组决定，与所属租户无关。
          </Alert>
          {detail.history.length ? (
            <FieldGroup variant="section" legend="归属修改历史">
              <ul className="usersAttributionHistory">
                {detail.history.map((item) => (
                  <li key={item.id}>
                    <Badge tone="neutral">{item.fromTenantId} → {item.toTenantId}</Badge>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </FieldGroup>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
