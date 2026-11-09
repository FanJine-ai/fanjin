import React from "react";
import { V4 } from "./tokens";

interface PageShellProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

const containerStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: V4.bg,
  padding: V4.pagePad,
  boxSizing: "border-box",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: V4.gapLg,
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  color: V4.textPrimary,
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: V4.textTertiary,
  marginTop: 4,
};

const PageShell: React.FC<PageShellProps> = ({
  title,
  subtitle,
  action,
  children,
}) => {
  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>{title}</h1>
          {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
        </div>
        {action && <div>{action}</div>}
      </div>
      {children}
    </div>
  );
};

export default React.memo(PageShell);
