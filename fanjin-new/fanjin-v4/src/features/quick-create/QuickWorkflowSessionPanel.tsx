import { useEffect, useRef, useState } from "react";

import { useSessionStore } from "./session/sessionStore";
import QuickWorkflowBriefPanel from "./QuickWorkflowBriefPanel";
import {
  defaultQuickWorkflowBrief,
  normalizeCommerceVariantBatch,
  normalizeQuickWorkflowBrief,
  type CommerceVariantBatch,
  type QuickWorkflowBrief,
} from "./quickModeWorkflow";

export default function QuickWorkflowSessionPanel() {
  const session = useSessionStore((state) => state.session);
  const saveSession = useSessionStore((state) => state.saveSession);
  const [brief, setBrief] = useState<QuickWorkflowBrief>(defaultQuickWorkflowBrief);
  const [batch, setBatch] = useState<CommerceVariantBatch | null>(null);
  const [saveError, setSaveError] = useState("");
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<{ brief: QuickWorkflowBrief; batch: CommerceVariantBatch | null } | null>(null);

  useEffect(() => {
    setBrief(normalizeQuickWorkflowBrief(session?.parameters?.workflowBrief));
    setBatch(normalizeCommerceVariantBatch(session?.parameters?.commerceVariantBatch));
  }, [session?.id]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) {
      void useSessionStore.getState().saveSession({
        parameters: {
          workflowBrief: pending.brief,
          commerceVariantBatch: pending.batch,
        },
      });
    }
  }, []);

  function scheduleSave(nextBrief: QuickWorkflowBrief, nextBatch: CommerceVariantBatch | null) {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = { brief: nextBrief, batch: nextBatch };
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      setSaveError("");
      void saveSession({
        parameters: {
          workflowBrief: nextBrief,
          commerceVariantBatch: nextBatch,
        },
      }).catch((error) => {
        setSaveError(error instanceof Error ? error.message : "快速模式创作设置保存失败");
      });
    }, 400);
  }

  return (
    <section data-testid="quick-workflow-session-panel" style={{ display: "grid", gap: 10 }}>
      <header>
        <strong>快速模式创作设置</strong>
        <p style={{ margin: "4px 0 0", color: "#71717a", fontSize: 13 }}>
          自动剪辑偏好、导演流程参数和电商多规格编排只在快速模式中维护。
        </p>
      </header>
      <QuickWorkflowBriefPanel
        value={brief}
        batch={batch}
        onChange={(next) => {
          setBrief(next);
          scheduleSave(next, batch);
        }}
        onBatchChange={(next) => {
          setBatch(next);
          scheduleSave(brief, next);
        }}
      />
      {saveError ? <div role="alert" style={{ color: "#b91c1c", fontSize: 13 }}>{saveError}</div> : null}
    </section>
  );
}
