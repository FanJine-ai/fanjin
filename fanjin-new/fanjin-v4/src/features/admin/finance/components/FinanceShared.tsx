import type { ReactNode } from "react";
import { Ban, CheckCircle2, CircleAlert, Clock3, Info } from "lucide-react";
import { Badge, Button, Drawer } from "../../../../ui/console";

type BadgeView = {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  icon: ReactNode;
};

export function statusView(status: string): BadgeView {
  const key = String(status || "").toLowerCase();
  if (["active", "enabled", "online", "success", "succeeded", "approved", "issued", "released", "captured"].includes(key)) {
    return { label: ({ active: "正常", succeeded: "已完成", approved: "已通过", issued: "已开具", released: "已释放", captured: "已扣款" } as Record<string, string>)[key] || key, tone: "success", icon: <CheckCircle2 size={14} /> };
  }
  if (["pending", "running", "frozen", "beta"].includes(key)) {
    return { label: ({ pending: "待处理", frozen: "已冻结", running: "执行中" } as Record<string, string>)[key] || key, tone: "warning", icon: <Clock3 size={14} /> };
  }
  if (["failed", "rejected", "cancelled", "closed", "revoked"].includes(key)) {
    return { label: ({ failed: "失败", rejected: "已驳回", cancelled: "已取消", closed: "已关闭", revoked: "已撤销" } as Record<string, string>)[key] || key, tone: "danger", icon: <CircleAlert size={14} /> };
  }
  if (["disabled", "suspended", "expired", "exhausted"].includes(key)) {
    return { label: ({ disabled: "停用", suspended: "已暂停", expired: "已过期", exhausted: "已用完" } as Record<string, string>)[key] || key, tone: "neutral", icon: <Ban size={14} /> };
  }
  return { label: key || "未知", tone: "neutral", icon: <Info size={14} /> };
}

export function StatusBadge({ status }: { status: string }) {
  const view = statusView(status);
  return <Badge tone={view.tone} icon={view.icon}>{view.label}</Badge>;
}

export function PrimaryCell({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <span className="financePrimaryCell">
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </span>
  );
}

export function MoneyCell({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <span className="financeMoneyCell">
      <strong>{primary}</strong>
      {secondary ? <span>{secondary}</span> : null}
    </span>
  );
}

export function EmptyView({ title, description }: { title: string; description: string }) {
  return (
    <div className="financeEmptyView">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

export function DetailList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="financeDetailList">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailDrawer({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Drawer
      open={open}
      title={title}
      description={description}
      size="640px"
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      footer={<div className="financeDrawerActions"><Button variant="secondary" onClick={onClose}>关闭</Button></div>}
    >
      <div className="financeDrawerStack">{children}</div>
    </Drawer>
  );
}
