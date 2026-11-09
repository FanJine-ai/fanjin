import { useState } from "react";
import { apiPostWithStepUp } from "../../../api/stepUp";
import { Alert, Button } from "../../../ui/console";

export function CommunityUpdateEntry() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try {
      const value = await apiPostWithStepUp<{ path: string }>("/admin/releases/community-update", {}, "admin.deployment", "打开本机版本更新");
      if (!value.path.startsWith("/__fanjin_update/#token=")) throw Error("更新入口无效");
      window.location.assign(value.path);
    } catch { setError("暂时无法打开本机更新页面，请重试。"); setBusy(false); }
  }
  return <section className="releaseControlModule" aria-label="本机版本与更新">
    <div className="releaseControlModule__heading">
      <div><h2>本机版本与更新</h2><p>检查社区新版本，保留配置、素材和创作任务。</p></div>
      <Button disabled={busy} onClick={() => void open()}>{busy ? "正在打开…" : "检查本机更新"}</Button>
    </div>
    {error ? <Alert tone="danger">{error}</Alert> : null}
  </section>;
}
