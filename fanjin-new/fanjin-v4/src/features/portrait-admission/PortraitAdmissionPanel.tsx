import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  X,
} from "lucide-react";
import { toApiErrorView } from "../../api/http";
import {
  authorizeRealPortrait,
  declarePortraitSource,
  getPortraitAdmission,
  PORTRAIT_DECLARATION_TERMS_VERSION,
  retryPortraitAdmission,
  registerPortraitAsset,
  type PortraitAdmission,
  type PortraitAdmissionStage,
  type PortraitDeclarationChoice,
} from "./api";
import { admissionDescription, admissionPresentation, formatAdmissionWait, isBackgroundAdmissionStage } from "./admissionFeedback";
import type { PortraitApprovalSnapshot } from "./PortraitAdmissionIndicator";
import "./PortraitAdmissionPanel.css";

export type PortraitAdmissionAsset = {
  assetVersionId: number;
  name: string;
  previewUrl?: string;
  mediaType: "image" | "video";
};

export type PortraitAdmissionPanelProps = {
  projectId: number | null;
  requireRegistration?: boolean;
  assets: readonly PortraitAdmissionAsset[];
  /** The route selected while adding the reference. It replaces the old
   * post-upload declaration step and is sent to the matching provider route. */
  model?: string;
  /** Refresh cached approvals when the parent generation task changes state. */
  refreshKey?: string;
  onBlockingChange?: (blocking: boolean) => void;
  variant?: "standalone" | "references";
  onApprovalChange?: (snapshot: PortraitApprovalSnapshot) => void;
  /** `pill` is the bare ready oval; `panel` needs the full card chrome. */
  onLayoutChange?: (layout: "hidden" | "pill" | "panel") => void;
};

type AdmissionEntry = {
  loading: boolean;
  admission?: PortraitAdmission;
  error?: string;
  waitingSince?: number;
};

const choiceOptions: ReadonlyArray<{
  value: PortraitDeclarationChoice | "ordinary_no_person";
  title: string;
  hint: string;
}> = [
  {
    value: "ordinary_no_person",
    title: "无人像",
    hint: "素材中没有人物，确认后按普通素材提交",
  },
  {
    value: "fully_virtual_person",
    title: "虚拟人像",
    hint: "AI 虚构角色，不对应真实个人；登记通过后使用",
  },
  {
    value: "real_person_with_rights",
    title: "真人像",
    hint: "对应现实中的人物 · 使用前可能需授权",
  },
];

function isPollingStage(stage: PortraitAdmissionStage) {
  return ["scanning", "moderating", "manual_review", "real_authorization_pending", "virtual_attestation", "trusted_output_verification", "syncing"]
    .includes(stage);
}

/**
 * Local prechecks are advisory. Only authoritative restrictions reported by
 * the server (such as revoked rights or a provider refusal) block submission.
 */
export function blocksCanvasForPortraitAdmission(
  admission: Pick<PortraitAdmission, "stage"> & Partial<Pick<PortraitAdmission, "blocking">> | null | undefined,
): boolean {
  return admission?.blocking === true;
}

function StageIcon({ stage }: { stage: PortraitAdmissionStage }) {
  if (stage === "ready") return <Check aria-hidden="true" size={17} />;
  if (stage === "failed" || stage === "blocked") return <AlertTriangle aria-hidden="true" size={17} />;
  if (stage === "needs_declaration" || stage === "needs_real_authorization") {
    return <ShieldCheck aria-hidden="true" size={17} />;
  }
  return <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} />;
}

/**
 * List chips must not collapse service failures (`failed`) into content
 * refusals (`blocked`), and must not invent an audit outcome when the status
 * read itself failed.
 */
export function portraitAdmissionListStatus(
  input: { error?: string; stage?: PortraitAdmissionStage } | undefined,
): string {
  if (input?.error) return "状态读取失败";
  switch (input?.stage) {
    case "ready":
      return "已通过";
    case "blocked":
      return "未通过";
    case "failed":
      return "检查暂时失败";
    case "needs_declaration":
      return "待确认";
    case "syncing":
      return "登记中";
    case "needs_real_authorization":
    case "real_authorization_pending":
      return "待授权";
    case undefined:
      return "读取中";
    default:
      return "检查中";
  }
}

export function PortraitAdmissionPanel({
  projectId,
  model,
  requireRegistration = false,
  assets,
  refreshKey,
  onBlockingChange,
  variant = "standalone",
  onApprovalChange,
  onLayoutChange,
}: PortraitAdmissionPanelProps) {
  const [entries, setEntries] = useState<Record<number, AdmissionEntry>>({});
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [identityLabel, setIdentityLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [expandedWhenReady, setExpandedWhenReady] = useState(false);
  const [readyPillHidden, setReadyPillHidden] = useState(false);
  const [authorizationFallbackUrl, setAuthorizationFallbackUrl] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const promptedVersionsRef = useRef(new Set<number>());
  const autoRoutedVersionsRef = useRef(new Set<string>());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const currentProjectRef = useRef(projectId);
  currentProjectRef.current = projectId;
  const loadedProjectRef = useRef(projectId);
  const lastRefreshKey = useRef(refreshKey);
  const [now, setNow] = useState(Date.now);

  const hasBackgroundChecks = Object.values(entries).some((entry) => entry.waitingSince != null);
  useEffect(() => {
    if (!hasBackgroundChecks) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasBackgroundChecks]);
  const elapsedFor = (entry?: AdmissionEntry) => entry?.waitingSince == null ? 0 : Math.max(0, now - entry.waitingSince);

  const normalizedAssets = useMemo(() => {
    const unique = new Map<number, PortraitAdmissionAsset>();
    assets.forEach((asset) => {
      if (Number.isSafeInteger(asset.assetVersionId) && asset.assetVersionId > 0) {
        unique.set(asset.assetVersionId, asset);
      }
    });
    return [...unique.values()];
  }, [assets]);
  const assetsKey = normalizedAssets.map((asset) => asset.assetVersionId).sort((a, b) => a - b).join(",");

  const loadAdmission = useCallback(async (assetVersionId: number, quiet = false) => {
    if (!projectId) return;
    if (!quiet) {
      setEntries((current) => ({
        ...current,
        [assetVersionId]: { ...current[assetVersionId], loading: true, error: undefined },
      }));
    }
    try {
      const admission = await getPortraitAdmission(projectId, assetVersionId);
      if (currentProjectRef.current !== projectId) return;
      setEntries((current) => ({ ...current, [assetVersionId]: {
        loading: false,
        admission,
        waitingSince: isBackgroundAdmissionStage(admission.stage)
          ? current[assetVersionId]?.waitingSince ?? Date.now()
          : undefined,
      } }));
    } catch (error) {
      if (currentProjectRef.current !== projectId) return;
      const { status } = toApiErrorView(error);
      const unavailable = status === 401 || status === 403 || status === 404;
      const message = status === 404 ? "素材不存在或已被移除，请重新选择素材"
        : status === 403 ? "当前账号无法读取该素材，请确认所在工作区"
        : status === 401 ? "登录已失效，请重新登录后查看素材"
        : "暂时无法读取素材检查结果，请稍后重新读取，无需重复上传";
      setEntries((current) => ({
        ...current,
        [assetVersionId]: {
          ...(unavailable ? {} : current[assetVersionId]),
          loading: false,
          error: message,
        },
      }));
    }
  }, [projectId]);

  useEffect(() => {
    const projectChanged = loadedProjectRef.current !== projectId;
    loadedProjectRef.current = projectId;
    if (projectChanged) {
      setSelectedVersionId(null);
      promptedVersionsRef.current.clear();
    }
    if (!projectId) {
      setEntries({});
      return;
    }
    const versionIds = new Set(normalizedAssets.map((asset) => asset.assetVersionId));
    setEntries((current) => Object.fromEntries(
      Object.entries(projectChanged ? {} : current).filter(([version]) => versionIds.has(Number(version))),
    ));
    normalizedAssets.forEach((asset) => {
      if (projectChanged || !entriesRef.current[asset.assetVersionId]?.admission) void loadAdmission(asset.assetVersionId);
    });
    // assetsKey intentionally represents the durable identity of this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, assetsKey, loadAdmission]);

  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    normalizedAssets.forEach((asset) => void loadAdmission(asset.assetVersionId, true));
  }, [refreshKey, normalizedAssets, loadAdmission]);

  useEffect(() => {
    if (!projectId) return;
    const pollingIds = normalizedAssets
      .map((asset) => asset.assetVersionId)
      .filter((versionId) => {
        const admission = entries[versionId]?.admission;
        if (!admission) return false;
        return isPollingStage(admission.stage)
          || (admission.stage === "failed" && admission.error?.code === "PORTRAIT_SCAN_FAILED");
      });
    if (!pollingIds.length) return;
    const timer = window.setTimeout(() => {
      pollingIds.forEach((versionId) => void loadAdmission(versionId, true));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [entries, loadAdmission, normalizedAssets, projectId]);

  // Submission restrictions come from the server; precheck progress is advisory.
  const blocking = normalizedAssets.some((asset) => (
    blocksCanvasForPortraitAdmission(entries[asset.assetVersionId]?.admission)
  ));
  useEffect(() => onBlockingChange?.(blocking), [blocking, onBlockingChange]);
  const approvedKey = loadedProjectRef.current === projectId ? normalizedAssets
    .filter((asset) => !entries[asset.assetVersionId]?.error && entries[asset.assetVersionId]?.admission?.stage === "ready")
    .map((asset) => asset.assetVersionId).sort((a, b) => a - b).join(",") : "";
  useEffect(() => {
    onApprovalChange?.({ projectId, assetVersionIds: approvedKey ? approvedKey.split(",").map(Number) : [] });
  }, [projectId, approvedKey, onApprovalChange]);


  const selectedAsset = normalizedAssets.find((asset) => asset.assetVersionId === selectedVersionId) || null;
  const selectedEntry = selectedVersionId ? entries[selectedVersionId] : undefined;
  const selectedAdmission = selectedEntry?.admission;

  function expandReadyDetails() {
    setExpandedWhenReady(true);
    normalizedAssets.forEach((asset) => void loadAdmission(asset.assetVersionId, true));
  }

  function openAdmission(assetVersionId: number) {
    setSelectedVersionId(assetVersionId);
    setActionError("");
    if (entries[assetVersionId]?.admission && !entries[assetVersionId]?.error) void loadAdmission(assetVersionId, true);
  }

  useEffect(() => {
    if (selectedVersionId) return;
    const candidate = normalizedAssets.find((asset) => {
      const admission = entries[asset.assetVersionId]?.admission;
      return admission?.stage === "needs_declaration"
        && admission.blocking
        && !promptedVersionsRef.current.has(asset.assetVersionId);
    });
    if (!candidate) return;
    promptedVersionsRef.current.add(candidate.assetVersionId);
    setSelectedVersionId(candidate.assetVersionId);
  }, [entries, normalizedAssets, selectedVersionId]);

  const closeDialog = useCallback(() => {
    setSelectedVersionId(null);
    setIdentityLabel("");
    setActionError("");
    setAuthorizationFallbackUrl("");
  }, []);

  useEffect(() => {
    if (!selectedVersionId) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog, selectedVersionId]);

  async function submitDeclaration(choice: PortraitDeclarationChoice | "ordinary_no_person") {
    if (!projectId || !selectedAdmission) return;
    setSubmitting(true);
    setActionError("");
    const assetVersionId = selectedAdmission.assetVersionId;
    try {
      // Always submit with the latest revision so a background scan/moderation
      // tick cannot turn a click into a dead "素材状态已更新" error.
      const fresh = await getPortraitAdmission(projectId, assetVersionId);
      let admission: PortraitAdmission;
      try {
        admission = await declarePortraitSource({
          projectId,
          assetVersionId,
          choice,
          revision: fresh.revision,
          termsVersion: PORTRAIT_DECLARATION_TERMS_VERSION,
          termsAccepted: true,
          model,
        });
      } catch (error) {
        const { status, code } = toApiErrorView(error);
        if (status !== 409 && code !== "portrait_revision_conflict") throw error;
        const latest = await getPortraitAdmission(projectId, assetVersionId);
        admission = await declarePortraitSource({
          projectId,
          assetVersionId,
          choice,
          revision: latest.revision,
          termsVersion: PORTRAIT_DECLARATION_TERMS_VERSION,
          termsAccepted: true,
          model,
        });
      }
      setEntries((current) => ({
        ...current,
        [admission.assetVersionId]: { loading: false, admission, waitingSince: isBackgroundAdmissionStage(admission.stage) ? Date.now() : undefined },
      }));
    } catch (error) {
      setActionError(toApiErrorView(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitAuthorization(labelOverride?: string) {
    const authorizationLabel = String(labelOverride ?? identityLabel).trim();
    if (!projectId || !selectedAdmission || !authorizationLabel) return;
    const authorizationWindow = window.open("about:blank", "_blank");
    if (authorizationWindow) {
      authorizationWindow.opener = null;
      authorizationWindow.document.title = "正在打开真人授权…";
    }
    setSubmitting(true);
    setActionError("");
    setAuthorizationFallbackUrl("");
    try {
      const result = await authorizeRealPortrait({
        projectId,
        assetVersionId: selectedAdmission.assetVersionId,
        revision: selectedAdmission.revision,
        identityLabel: authorizationLabel,
        rightsConfirmed: true,
      });
      const { admission } = result;
      setEntries((current) => ({
        ...current,
        [admission.assetVersionId]: { loading: false, admission, waitingSince: isBackgroundAdmissionStage(admission.stage) ? Date.now() : undefined },
      }));
      setIdentityLabel("");
      if (authorizationWindow) authorizationWindow.location.replace(result.authorizationUrl);
      else setAuthorizationFallbackUrl(result.authorizationUrl);
    } catch (error) {
      authorizationWindow?.close();
      setActionError(toApiErrorView(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function registerAssetFor(assetVersionId: number, revision: number, targetModel?: string) {
    if (!projectId) return;
    try {
      const admission = await registerPortraitAsset({
        projectId,
        assetVersionId,
        revision,
        ...(targetModel ? { model: targetModel } : {}),
      });
      setEntries((current) => ({
        ...current,
        [admission.assetVersionId]: { loading: false, admission, waitingSince: isBackgroundAdmissionStage(admission.stage) ? Date.now() : undefined },
      }));
      return admission;
    } catch (error) {
      throw error;
    }
  }

  async function registerAsset() {
    if (!projectId || !selectedAdmission) return;
    setSubmitting(true);
    setActionError("");
    try {
      await registerAssetFor(selectedAdmission.assetVersionId, selectedAdmission.revision, model);
    } catch (error) {
      setActionError(toApiErrorView(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // A model/route is chosen before the reference is uploaded. Automatically
  // prepare a pending admission on that route so the old declaration dialog
  // cannot interrupt generation after upload.
  useEffect(() => {
    const targetModel = String(model || "").trim();
    if (!projectId || !targetModel) return;
    normalizedAssets.forEach((asset) => {
      const admission = entries[asset.assetVersionId]?.admission;
      if (!admission || admission.stage !== "needs_declaration") return;
      const key = `${projectId}:${asset.assetVersionId}:${admission.revision}:${targetModel}`;
      if (autoRoutedVersionsRef.current.has(key)) return;
      autoRoutedVersionsRef.current.add(key);
      void registerAssetFor(asset.assetVersionId, admission.revision, targetModel).catch((error) => {
        const message = toApiErrorView(error).message;
        setEntries((current) => ({
          ...current,
          [asset.assetVersionId]: { ...current[asset.assetVersionId], loading: false, error: message },
        }));
      });
    });
  }, [entries, model, normalizedAssets, projectId]);

  async function retryAdmission() {
    if (!projectId || !selectedAdmission) return;
    setSubmitting(true);
    setActionError("");
    try {
      const admission = await retryPortraitAdmission({
        projectId,
        assetVersionId: selectedAdmission.assetVersionId,
        revision: selectedAdmission.revision,
      });
      setEntries((current) => ({
        ...current,
        [admission.assetVersionId]: { loading: false, admission, waitingSince: isBackgroundAdmissionStage(admission.stage) ? Date.now() : undefined },
      }));
    } catch (error) {
      setActionError(toApiErrorView(error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedElapsed = elapsedFor(selectedEntry);
  const selectedPresentation = selectedAdmission ? {
    ...admissionPresentation(selectedAdmission.stage, selectedElapsed),
    ...(model && selectedAdmission.stage === "needs_declaration"
      ? { title: "正在按所选线路准备素材", description: "无需重复声明，平台会自动完成当前线路登记。", tone: "progress" as const }
      : {}),
    ...(selectedAdmission.stage === "blocked" && !selectedAdmission.blocking
      ? { title: "人像检查未通过", tone: "attention" as const } : {}),
  } : null;

  const visibleAssets = variant === "references" ? normalizedAssets.filter((asset) => {
    const entry = entries[asset.assetVersionId];
    return entry?.error || ["blocked", "failed", "needs_declaration", "needs_real_authorization", "real_authorization_pending"]
      .includes(entry?.admission?.stage || "");
  }) : normalizedAssets;

  const allReady = normalizedAssets.length > 0 && normalizedAssets.every((asset) => {
    const entry = entries[asset.assetVersionId];
    return !entry?.error && entry?.admission?.stage === "ready";
  });
  const issueAssets = normalizedAssets.filter((asset) => {
    const entry = entries[asset.assetVersionId];
    return Boolean(entry?.error) || ["blocked", "failed"].includes(entry?.admission?.stage || "");
  });
  const issueStatuses = new Set(issueAssets.map((asset) => {
    const entry = entries[asset.assetVersionId];
    return portraitAdmissionListStatus({ error: entry?.error, stage: entry?.admission?.stage });
  }));
  const issueSummary = issueStatuses.size === 1
    ? `素材${[...issueStatuses][0]}`
    : "素材检查需处理";
  const showCollapsed = allReady && !expandedWhenReady && !selectedAsset && !readyPillHidden;

  // Ready pill is a one-shot toast: show briefly, then get out of the way.
  useEffect(() => {
    if (!allReady || expandedWhenReady || selectedAsset) {
      setReadyPillHidden(false);
      return;
    }
    setReadyPillHidden(false);
    const timer = window.setTimeout(() => setReadyPillHidden(true), 4500);
    return () => window.clearTimeout(timer);
  }, [allReady, expandedWhenReady, selectedAsset, normalizedAssets.length, projectId]);

  useEffect(() => {
    if (!onLayoutChange) return;
    if (allReady && readyPillHidden && !expandedWhenReady && !selectedAsset) onLayoutChange("hidden");
    else if (showCollapsed) onLayoutChange("pill");
    else onLayoutChange("panel");
  }, [onLayoutChange, allReady, readyPillHidden, showCollapsed, expandedWhenReady, selectedAsset]);

  if (!projectId || normalizedAssets.length === 0 || (!visibleAssets.length && !selectedAsset)) return null;
  if (allReady && readyPillHidden && !expandedWhenReady && !selectedAsset) return null;

  return (
    <section className={`portraitAdmissionPanel ${showCollapsed ? "is-collapsed" : ""}`} aria-label="人物素材准入状态">
      {showCollapsed ? (
        <div className="portraitAdmissionPillWrap">
          <button
            type="button"
            className="portraitAdmissionPill is-ready"
            onClick={expandReadyDetails}
            aria-label="人物素材全部已通过，展开详情"
          >
            <span className="portraitAdmissionPillIcon" aria-hidden="true">✓</span>
            <span className="portraitAdmissionPillText">全部通过 {normalizedAssets.length}</span>
          </button>
          <div className="portraitAdmissionPillDetail" role="tooltip">
            {normalizedAssets.map((asset, index) => (
              <div key={asset.assetVersionId} className="portraitAdmissionPillRow">
                <span className="ok" aria-hidden="true">✓</span>
                <span className="name">{index + 1} · {asset.name}</span>
              </div>
            ))}
            <button type="button" className="portraitAdmissionPillMore" onClick={expandReadyDetails}>展开详情</button>
          </div>
        </div>
      ) : null}
      {!showCollapsed && issueAssets.length > 0 && !selectedAsset ? (
        <div className="portraitAdmissionPillWrap">
          <button
            type="button"
            className="portraitAdmissionPill is-failed"
            onClick={() => {
              const first = issueAssets[0];
              if (first) openAdmission(first.assetVersionId);
            }}
            aria-label={`${issueSummary}，查看详情`}
          >
            <span className="portraitAdmissionPillIcon" aria-hidden="true">!</span>
            <span className="portraitAdmissionPillText">{issueSummary}</span>
          </button>
          <div className="portraitAdmissionPillDetail" role="tooltip">
            {normalizedAssets.map((asset, index) => {
              const entry = entries[asset.assetVersionId];
              const ok = !entry?.error && entry?.admission?.stage === "ready";
              const bad = Boolean(entry?.error) || ["blocked", "failed"].includes(entry?.admission?.stage || "");
              return (
                <div
                  key={asset.assetVersionId}
                  className="portraitAdmissionPillRow"
                  title={`${asset.name}：${portraitAdmissionListStatus({ error: entry?.error, stage: entry?.admission?.stage })}`}
                >
                  <span className={ok ? "ok" : bad ? "bad" : "wait"} aria-hidden="true">{ok ? "✓" : bad ? "!" : "…"}</span>
                  <span className="name">{index + 1} · {asset.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {visibleAssets.length > 0 && !showCollapsed ? (
        <div className="portraitAdmissionStatuses" aria-live="polite">
          {allReady ? (
            <button
              type="button"
              className="portraitAdmissionCollapse"
              onClick={() => setExpandedWhenReady(false)}
              aria-label="收起人物素材检查列表"
            >
              收起
            </button>
          ) : null}
        {visibleAssets.map((asset) => {
          const entry = entries[asset.assetVersionId];
          const stage = entry?.admission?.stage;
          const elapsed = elapsedFor(entry);
          const presentation = stage ? admissionPresentation(stage, elapsed) : null;
          const status = portraitAdmissionListStatus({ error: entry?.error, stage });
          const nameLabel = normalizedAssets.length > 1
            ? `${normalizedAssets.indexOf(asset) + 1} · ${asset.name}`
            : asset.name;
          return (
            <button
              key={asset.assetVersionId}
              type="button"
              className={`portraitAdmissionStatus ${variant === "references" ? "portraitAdmissionNotice" : ""} ${entry?.error ? "danger" : presentation?.tone || "progress"}`}
              onClick={() => openAdmission(asset.assetVersionId)}
              aria-label={`查看 ${asset.name} 的人物素材检查`}
              aria-description={status}
              title={`${nameLabel}：${entry?.error || presentation?.title || "正在读取检查状态"}`}
            >
              <span className="portraitAdmissionStatusIcon">
                {entry?.error
                  ? <AlertTriangle aria-hidden="true" size={17} />
                  : stage ? <StageIcon stage={stage} />
                    : <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} />}
              </span>
              <span className={`portraitAdmissionStatusReference ${variant === "references" ? "portraitAdmissionNoticeName" : "portraitAdmissionStatusName"}`}>
                {nameLabel}
              </span>
              <span>{status}</span>
            </button>
          );
        })}
        </div>
      ) : null}

      {selectedAsset ? (
        <div className="portraitAdmissionOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}>
          <section
            className="portraitAdmissionDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="portrait-admission-title"
          >
            <button
              ref={closeButtonRef}
              type="button"
              className="portraitAdmissionClose"
              aria-label="关闭人物素材检查"
              onClick={closeDialog}
            ><X aria-hidden="true" size={20} /></button>

            <div className="portraitAdmissionDialogHeading">
              <span className="portraitAdmissionHeroIcon"><ScanFace aria-hidden="true" size={23} /></span>
              <div>
                <p>人物素材检查</p>
                <h2 id="portrait-admission-title">{selectedAsset.name}</h2>
                <p className="portraitAdmissionVersionMeta">素材版本 #{selectedAsset.assetVersionId}</p>
              </div>
            </div>

            {selectedEntry?.loading && !selectedAdmission ? (
              <div className="portraitAdmissionLoading" role="status">
                <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={21} /> 正在读取素材检查结果…
              </div>
            ) : selectedEntry?.error && !selectedAdmission ? (
              <div className="portraitAdmissionInlineError" role="alert">
                <AlertTriangle aria-hidden="true" size={18} />
                <span>{selectedEntry.error}。</span>
                <button type="button" onClick={() => void loadAdmission(selectedAsset.assetVersionId)}>
                  <RefreshCw aria-hidden="true" size={16} /> 重新读取
                </button>
              </div>
            ) : selectedAdmission ? (
              <>
                {selectedEntry?.error ? <div className="portraitAdmissionInlineError" role="alert">{selectedEntry.error}。</div> : null}
                <div className={`portraitAdmissionSummary ${selectedPresentation?.tone}`} role="status">
                  <StageIcon stage={selectedAdmission.stage} />
                  <div>
                    <strong>{selectedPresentation?.title}</strong>
                    <span>{requireRegistration && selectedAdmission.stage === "syncing" ? "正在登记火山人像素材，完成后可用于所选视频通道。" : admissionDescription(selectedAdmission, selectedElapsed)}</span>
                    {selectedEntry?.waitingSince != null ? <span>{formatAdmissionWait(selectedElapsed)}</span> : null}
                  </div>
                </div>
                {!requireRegistration && !selectedAdmission.blocking && selectedAdmission.stage !== "ready" ? (
                  <p className="portraitAdmissionChoiceLead">人像检查不影响开始生成，可直接提交；若生成平台拒绝，会在任务中提示具体原因。</p>
                ) : null}

                {selectedAdmission.mediaType === "video" && selectedAdmission.stage === "scanning"
                  && selectedAdmission.declarationState === "pending" && !model ? (
                  <div className="portraitAdmissionChoices">
                    <p className="portraitAdmissionChoiceLead">已确定视频中是 AI 虚构人物？</p>
                    <p>确认来源后可直接登记整段视频，无需等待抽帧检测。实际真人不能按虚拟人像声明。</p>
                    <div className="portraitAdmissionDisclaimerText" role="note">{selectedAdmission.disclaimer.text}</div>
                    <button type="button" className="portraitAdmissionPrimary" disabled={submitting}
                      onClick={() => void submitDeclaration("fully_virtual_person")}>
                      {submitting ? "正在提交…" : "确认虚拟来源并登记视频"}
                    </button>
                  </div>
                ) : null}

                {(selectedAdmission.stage === "needs_declaration"
                  || (selectedAdmission.classificationRequired
                    && selectedAdmission.stage === "failed"
                    && !selectedAdmission.userClassification)) && !model ? (
                  <div className="portraitAdmissionChoices">
                    {selectedAdmission.error?.code === "PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED" ? (
                      <>
                        <p className="portraitAdmissionChoiceLead">请确认人物素材的真实来源</p>
                        <div className="portraitAdmissionDisclaimerText" role="note">
                          <p>未检出人脸不代表没有人物。火山已提示该参考素材可能含真人，需要补充人物登记。</p>
                          <p>只有确属虚构、AI 生成的人物，且你拥有素材使用权时，才能确认虚拟来源。涉及真人或来源不确定时，请更换素材或联系管理员复核。</p>
                          <p>确认后会提交火山虚拟人像库审核，审核通过后才可重新生成；不会自动再次扣费生成。</p>
                          <p>{selectedAdmission.disclaimer.text}</p>
                        </div>
                        <button type="button" className="portraitAdmissionPrimary" disabled={submitting}
                          onClick={() => void submitDeclaration("fully_virtual_person")}>
                          {submitting ? <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}
                          确认虚拟来源并登记
                        </button>
                      </>
                    ) : selectedAdmission.faceSignal === "present" ? (
                      <>
                        <p className="portraitAdmissionChoiceLead">检测到人像</p>
                        <div className="portraitAdmissionDisclaimerText" role="note">
                          <p><strong>免责声明</strong></p>
                          <p>本平台目前<strong>仅支持虚拟人像</strong>处理：检测到人物后，将按虚拟人像（AIGC）入库并用于生成参考，不提供真人肖像授权通道。</p>
                          <p>{selectedAdmission.disclaimer.text}</p>
                        </div>
                        <button
                          type="button"
                          className="portraitAdmissionPrimary"
                          disabled={submitting}
                          onClick={() => void submitDeclaration("fully_virtual_person")}
                        >
                          {submitting ? <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}
                          确认并按虚拟人像继续
                        </button>
                      </>
                    ) : (
                      <>
                    <p className="portraitAdmissionChoiceLead">
                      {selectedAdmission.faceSignal === "inconclusive" || selectedAdmission.stage === "failed"
                        ? "检测未能判断是否有人像，请按实际内容确认"
                        : "选一项确认素材类型"}
                    </p>
                    <div className="portraitAdmissionOptionList" role="group" aria-label="素材类型">
                      {choiceOptions.map((option) => {
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className="portraitAdmissionOption"
                            disabled={submitting}
                            onClick={() => void submitDeclaration(option.value)}
                          >
                            <span className="portraitAdmissionOptionHead">
                              <strong>{option.title}</strong>
                            </span>
                            <small>{option.hint}</small>
                          </button>
                        );
                      })}
                    </div>
                    {selectedAdmission.mediaType === "video" ? (
                      <p className="portraitAdmissionChoiceLead">虚拟人像视频将按整段视频单独登记；角色图片的登记不能替代视频登记。同一视频版本登记有效后可重复使用。</p>
                    ) : null}
                    <details className="portraitAdmissionDisclaimerText">
                      <summary>确认即表示已阅读免责声明</summary>
                      <p>{selectedAdmission.disclaimer.text}</p>
                    </details>
                      </>
                    )}
                  </div>
                ) : null}

                {selectedAdmission.stage === "needs_real_authorization" ? (
                  <div className="portraitAdmissionAuthorization">
                    <label htmlFor="portrait-identity-label">授权对象</label>
                    <input
                      id="portrait-identity-label"
                      value={identityLabel}
                      maxLength={120}
                      onChange={(event) => setIdentityLabel(event.target.value)}
                      placeholder="例如：本人 / 已签约演员姓名"
                    />
                    <p>提交即确认你拥有本次创作所需的肖像与素材使用权。</p>
                    <button type="button" className="portraitAdmissionPrimary" disabled={!identityLabel.trim() || submitting} onClick={() => void submitAuthorization()}>
                      {submitting ? <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}
                      确认授权并继续
                    </button>
                  </div>
                ) : null}

                {selectedAdmission.stage === "real_authorization_pending" ? (
                  <div className="portraitAdmissionAuthorization" role="status">
                    <p>授权结果由服务端回调确认。没有完成前不会创建生成任务，也不会扣除 GU。</p>
                    {authorizationFallbackUrl ? (
                      <a
                        className="portraitAdmissionPrimary"
                        href={authorizationFallbackUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >打开真人授权页面</a>
                    ) : (
                      <button
                        type="button"
                        className="portraitAdmissionPrimary"
                        disabled={submitting || !selectedAdmission.identityLabel}
                        onClick={() => void submitAuthorization(selectedAdmission.identityLabel)}
                      >
                        {submitting ? <Loader2 className="portraitAdmissionSpin" aria-hidden="true" size={17} /> : <RefreshCw aria-hidden="true" size={17} />}
                        重新发起真人授权
                      </button>
                    )}
                  </div>
                ) : null}

                {selectedAdmission.stage === "syncing" && (selectedAdmission.declarationState === "confirmed" || selectedAdmission.subjectKind === "detected_person") ? (
                  <button type="button" className="portraitAdmissionPrimary" disabled={submitting} onClick={() => void registerAsset()}>
                    <RefreshCw className={submitting ? "portraitAdmissionSpin" : ""} aria-hidden="true" size={17} />
                    {submitting ? "正在登记…" : selectedAdmission.mediaType === "video" ? "登记视频人像资产" : "登记人像资产"}
                  </button>
                ) : null}

                {selectedAdmission.error?.code !== "PORTRAIT_VIDEO_STORAGE_AUTHORITY_UNAVAILABLE" && (selectedAdmission.stage === "failed"
                  || selectedAdmission.faceRetryAllowed
                  || (selectedEntry?.error && selectedAdmission.stage !== "needs_declaration")) ? (
                  <button type="button" className="portraitAdmissionPrimary" disabled={submitting} onClick={() => void retryAdmission()}>
                    <RefreshCw className={submitting ? "portraitAdmissionSpin" : ""} aria-hidden="true" size={17} />
                    重试检查
                  </button>
                ) : null}

                {actionError ? <div className="portraitAdmissionInlineError" role="alert"><AlertTriangle aria-hidden="true" size={17} /> {actionError}</div> : null}
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default PortraitAdmissionPanel;
