import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { startTenantTransfer } from "../../api/auth";
import AuthShell from "./AuthShell";

export default function TenantTransferPage() {
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState("正在安全同步登录状态…");
  const targetOrigin = String(searchParams.get("targetOrigin") || "").trim();
  const targetTenantId = String(searchParams.get("targetTenantId") || "").trim() || null;
  const redirectPath = String(searchParams.get("redirectPath") || "/workbench/create").trim();

  useEffect(() => {
    let cancelled = false;
    if (!targetOrigin) {
      setMessage("缺少目标入口，请从目标站点重新进入。");
      return;
    }
    void startTenantTransfer({ targetOrigin, targetTenantId, redirectPath })
      .then((result) => {
        if (!cancelled) window.location.replace(result.redirectUrl);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "登录状态同步失败，请重试。");
      });
    return () => { cancelled = true; };
  }, [redirectPath, targetOrigin, targetTenantId]);

  return (
    <AuthShell title="跨入口登录" subtitle="账号与创作数据保持一致">
      <div style={{ color: "var(--auth-muted)", fontSize: 14, lineHeight: 1.7 }}>{message}</div>
    </AuthShell>
  );
}
