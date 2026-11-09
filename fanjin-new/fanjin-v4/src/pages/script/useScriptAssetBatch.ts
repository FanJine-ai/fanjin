import { useEffect, useRef, useState } from "react";
import { apiPost } from "../../api/http";
import { useAuthStore } from "../../stores/authStore";
import { ScriptAssetBatchController, type ExtractionBatchJob } from "./scriptAssetBatch";

export function useScriptAssetBatch(projectId: number | null, onReady: (proposal: unknown) => void) {
  const scope = useAuthStore((state) => `${state.user?.id || "guest"}:${state.currentWorkspace?.id || "none"}`);
  const [job, setJob] = useState<ExtractionBatchJob | null>(null);
  const controller = useRef<ScriptAssetBatchController | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const activeIdentity = useRef("");
  activeIdentity.current = `${scope}:${projectId}`;
  useEffect(() => {
    if (!projectId) { controller.current = null; setJob(null); return; }
    const instance = new ScriptAssetBatchController({
      projectId, storageKey: `fanjin:script-asset-batches:v1:${scope}:${projectId}`, storage: sessionStorage,
      api: (path, payload, key) => {
        const auth = useAuthStore.getState();
        const currentScope = `${auth.user?.id || "guest"}:${auth.currentWorkspace?.id || "none"}`;
        if (currentScope !== scope || activeIdentity.current !== `${scope}:${projectId}`) return Promise.reject(new Error("项目或账号已切换，批处理已暂停"));
        return apiPost(path, payload, undefined, { headers: { "Idempotency-Key": key } });
      },
      changed: (job) => { if (activeIdentity.current === `${scope}:${projectId}`) setJob(job); },
      ready: (proposal) => { if (activeIdentity.current === `${scope}:${projectId}`) ready.current(proposal); },
    });
    controller.current = instance;
    setJob(instance.job);
    return () => { instance.dispose(); controller.current = null; };
  }, [projectId, scope]);
  return {
    job,
    start: (sources: Parameters<ScriptAssetBatchController["start"]>[0]) => controller.current?.start(sources),
    resume: () => controller.current?.resume(),
    pause: () => controller.current?.pause(),
    refresh: () => controller.current?.refresh(),
    clear: () => controller.current?.clear(),
  };
}
