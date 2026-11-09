import React from "react";
import { V4 } from "./tokens";

type StatusPreset = "active" | "running" | "success" | "warning" | "error" | "idle";

interface StatusBadgeProps {
  status: StatusPreset | string;
  label?: string;
}

const statusColorMap: Record<string, { bg: string; text: string }> = {
  active:  { bg: "rgba(191, 232, 209, 0.18)", text: V4.success },
  running: { bg: "rgba(215, 233, 255, 0.18)", text: V4.accent },
  success: { bg: "rgba(191, 232, 209, 0.18)", text: V4.success },
  warning: { bg: "rgba(240, 216, 156, 0.18)", text: V4.warning },
  error:   { bg: "rgba(240, 166, 166, 0.18)", text: V4.danger },
  idle:    { bg: "rgba(255, 255, 255, 0.08)", text: V4.textTertiary },
};

const statusLabelMap: Record<string, string> = {
  active:  "运行中",
  running: "执行中",
  success: "成功",
  warning: "警告",
  error:   "错误",
  idle:    "空闲",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 10px",
  borderRadius: 20,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: "20px",
  whiteSpace: "nowrap",
};

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label }) => {
  const colors = statusColorMap[status] ?? {
    bg: "rgba(255,255,255,0.08)",
    text: V4.textTertiary,
  };
  const displayLabel = label ?? statusLabelMap[status] ?? status;

  return (
    <span
      style={{
        ...badgeStyle,
        background: colors.bg,
        color: colors.text,
      }}
    >
      {displayLabel}
    </span>
  );
};

export default React.memo(StatusBadge);
