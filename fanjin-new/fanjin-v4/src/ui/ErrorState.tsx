import React from "react";
import { V4 } from "./tokens";
import { AlertTriangle } from "lucide-react";
import type { ApiErrorView } from "../api/http";

interface ErrorStateProps {
  error: ApiErrorView | string;
  onRetry?: () => void;
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 60,
  gap: 16,
  textAlign: "center",
};

const messageStyle: React.CSSProperties = {
  color: V4.danger,
  fontSize: 15,
  fontWeight: 500,
  maxWidth: 400,
};

const detailStyle: React.CSSProperties = {
  color: V4.textTertiary,
  fontSize: 12,
  marginTop: 4,
};

const retryBtnStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 24px",
  borderRadius: 12,
  border: `1px solid ${V4.danger}`,
  background: "transparent",
  color: V4.danger,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const ErrorState: React.FC<ErrorStateProps> = ({ error, onRetry }) => {
  const isString = typeof error === "string";
  const message = isString ? error : error.message;
  const detail = isString ? null : error.status ?? error.code;

  return (
    <div style={containerStyle}>
      <AlertTriangle size={40} color={V4.danger} strokeWidth={1.5} />
      <div style={messageStyle}>{message}</div>
      {detail && <div style={detailStyle}>{detail}</div>}
      {onRetry && (
        <button style={retryBtnStyle} onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
};

export default React.memo(ErrorState);
