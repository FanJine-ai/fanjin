import React from "react";
import { V4 } from "./tokens";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 60,
  color: V4.textTertiary,
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: V4.textSecondary,
  marginTop: 16,
  marginBottom: 8,
};

const descriptionStyle: React.CSSProperties = {
  fontSize: 14,
  color: V4.textTertiary,
  maxWidth: 360,
  lineHeight: 1.6,
};

const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
}) => {
  return (
    <div style={containerStyle}>
      <Icon size={48} strokeWidth={1.5} color={V4.textTertiary} />
      <div style={titleStyle}>{title}</div>
      {description && <div style={descriptionStyle}>{description}</div>}
      {action && <div style={{ marginTop: 20 }}>{action}</div>}
    </div>
  );
};

export default React.memo(EmptyState);
