import React from "react";
import { V4 } from "./tokens";
import { Loader2 } from "lucide-react";

interface LoadingStateProps {
  message?: string;
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 60,
  gap: 16,
};

const spinKeyframes = `
@keyframes v4-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;

const LoadingState: React.FC<LoadingStateProps> = ({ message = "加载中…" }) => {
  return (
    <>
      <style>{spinKeyframes}</style>
      <div style={containerStyle}>
        <Loader2
          size={32}
          color={V4.accent}
          style={{ animation: "v4-spin 1s linear infinite" }}
        />
        <span style={{ color: V4.textTertiary, fontSize: 14 }}>{message}</span>
      </div>
    </>
  );
};

export default React.memo(LoadingState);
