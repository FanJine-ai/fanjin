import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FilePenLine,
  Files,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { apiPost } from "../../api/http";
import {
  resolveStableSubmissionAttempt,
  type StableSubmissionAttempt,
} from "../../features/quick-create/submissionAttempt";
import { useProjectStore } from "../../stores/projectStore";
import { ConfirmDialog } from "../../ui/console";
import WritingWorkspaceFrame from "../writing/WritingWorkspaceFrame";
import AddScript from "./components/AddScript";
import EditScript from "./components/EditScript";
import BatchAddScript from "./components/BatchAddScript";
import { planScriptAssetBatches } from "./scriptAssetBatch";
import { useScriptAssetBatch } from "./useScriptAssetBatch";

interface ScriptItem {
  id: number | string;
  title?: string;
  name?: string;
  content?: string;
  relatedAssets: Array<{
    id: number;
    name: string;
  }>;
}

type ScriptPageProps = {
  embedded?: boolean;
  onOpenAssetGeneration?: (savedAssetIds: number[]) => void;
};

type ScriptDeleteIntent = {
  projectId: number;
  id: number;
  title: string;
  intentToken: string;
  idempotencyKey: string;
};

type ScriptDeleteError = {
  intentToken: string;
  message: string;
};

type ExtractedAssetType = "role" | "scene" | "tool";

type ExtractedAssetProposal = {
  clientId: string;
  name: string;
  describe: string;
  prompt: string;
  type: ExtractedAssetType;
  parentClientId?: string;
  stateLabel?: string;
};

type ExtractedAssetDraft = ExtractedAssetProposal & {
  selected: boolean;
};

type ScriptAssetProposal = {
  proposalId: string;
  assets: ExtractedAssetDraft[];
};

type CompletedAssetExtraction = {
  projectId: number;
  savedAssetIds: number[];
};

type PendingRequest = {
  projectId: number;
  requestToken: string;
};

type PersistedExtractionAttempt = StableSubmissionAttempt & {
  version: 1;
  projectId: number;
  scriptIds: number[];
};

type ExtractionStatus = {
  state: "proposal_ready" | "in_progress" | "pending_reconcile" | "retry_allowed" | "manual_required";
  referenceId?: string;
  reconcileJobId?: string;
  canStartNewAttempt?: boolean;
  retryMode?: "same_attempt" | "new_attempt" | null;
  code?: string;
  message?: string;
  proposal?: unknown;
};

function normalizeSavedAssetIds(value: unknown): number[] {
  const response = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!Array.isArray(response?.savedAssetIds)) {
    throw new Error("资产保存响应缺少 savedAssetIds");
  }
  const ids = response.savedAssetIds.map(Number);
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("资产保存响应的 savedAssetIds 无效");
  }
  return [...new Set(ids)];
}

function extractionAttemptStorageKey(projectId: number) {
  return `fanjin:script-asset-extraction-attempt:v1:${projectId}`;
}

function compactScriptContentFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readPersistedExtractionAttempt(projectId: number): PersistedExtractionAttempt | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(extractionAttemptStorageKey(projectId)) || "null");
    if (
      parsed?.version !== 1
      || parsed?.projectId !== projectId
      || typeof parsed?.fingerprint !== "string"
      || typeof parsed?.idempotencyKey !== "string"
      || !parsed.idempotencyKey
      || !Array.isArray(parsed?.scriptIds)
      || parsed.scriptIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0)
    ) return null;
    return parsed as PersistedExtractionAttempt;
  } catch {
    return null;
  }
}

function persistExtractionAttempt(value: PersistedExtractionAttempt | null) {
  if (!value) return;
  try {
    sessionStorage.setItem(extractionAttemptStorageKey(value.projectId), JSON.stringify(value));
  } catch {
    // Recovery remains available in-memory when browser storage is disabled.
  }
}

function clearPersistedExtractionAttempt(projectId: number) {
  try {
    sessionStorage.removeItem(extractionAttemptStorageKey(projectId));
  } catch {
    // Ignore unavailable browser storage.
  }
}

function extractionStatusRequiresRefresh(code: string) {
  return [
    "script_asset_extraction_pending_reconcile",
    "script_asset_extraction_in_progress",
    "script_asset_extraction_manual_required",
    "script_asset_extraction_settled_without_proposal",
    "script_asset_extraction_recovery_binding_failed",
  ].includes(code);
}

const extractedAssetTypeLabels: Record<ExtractedAssetType, string> = {
  role: "角色",
  scene: "场景",
  tool: "道具",
};

function proposalText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`资产提取提案的 ${field} 无效`);
  }
  return value.trim();
}

export function normalizeScriptAssetProposal(value: unknown): ScriptAssetProposal {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const proposalId = proposalText(row?.proposalId, "proposalId");
  if (!Array.isArray(row?.assets)) throw new Error("资产提取提案缺少资产列表");
  const ids = new Set<string>();
  const assets = row.assets.map((value, index): ExtractedAssetDraft => {
    const asset = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    if (!asset) throw new Error(`资产提取提案第 ${index + 1} 项无效`);
    const clientId = proposalText(asset.clientId, `第 ${index + 1} 项 clientId`);
    if (ids.has(clientId)) throw new Error(`资产提取提案 clientId 重复：${clientId}`);
    ids.add(clientId);
    const type = asset.type;
    if (type !== "role" && type !== "scene" && type !== "tool") {
      throw new Error(`资产提取提案第 ${index + 1} 项类型无效`);
    }
    return {
      clientId,
      name: proposalText(asset.name, `第 ${index + 1} 项名称`),
      describe: proposalText(asset.describe, `第 ${index + 1} 项描述`, true),
      prompt: proposalText(asset.prompt, `第 ${index + 1} 项提示词`, true),
      type,
      ...(typeof asset.parentClientId === "string" && asset.parentClientId.trim()
        ? { parentClientId: asset.parentClientId.trim() }
        : {}),
      ...(typeof asset.stateLabel === "string" && asset.stateLabel.trim()
        ? { stateLabel: asset.stateLabel.trim() }
        : {}),
      selected: true,
    };
  });
  return { proposalId, assets };
}

function scriptAssetProposalHierarchyError(assets: ExtractedAssetDraft[]): string {
  const assetsById = new Map(assets.map((asset) => [asset.clientId, asset]));
  for (const asset of assets) {
    if (!asset.selected || !asset.parentClientId) continue;
    const parent = assetsById.get(asset.parentClientId);
    if (
      !parent
      || parent.clientId === asset.clientId
      || Boolean(parent.parentClientId)
      || !parent.selected
      || parent.type !== asset.type
    ) {
      return "状态变体需要选中同类型基础资产，请修正基础资产关联。";
    }
  }
  return "";
}

function normalizeScriptItem(item: ScriptItem): ScriptItem {
  return {
    ...item,
    title: item.title || item.name || "未命名",
  };
}

export function normalizeScriptListResponse(value: unknown): ScriptItem[] {
  if (!Array.isArray(value)) {
    throw new Error("剧本列表响应格式无效，已阻止展示空数据");
  }
  return value.map((entry, index) => {
    const row = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const id = Number(row?.id);
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (
      !row
      || !Number.isSafeInteger(id)
      || id <= 0
      || !name
      || typeof row.content !== "string"
      || !Array.isArray(row.relatedAssets)
    ) {
      throw new Error(`剧本列表第 ${index + 1} 条记录格式无效，已阻止展示不完整数据`);
    }
    return normalizeScriptItem({
      id,
      name,
      content: row.content,
      relatedAssets: row.relatedAssets.map((asset, assetIndex) => {
        const related = asset && typeof asset === "object" && !Array.isArray(asset)
          ? asset as Record<string, unknown>
          : null;
        const relatedId = Number(related?.id);
        const relatedName = typeof related?.name === "string"
          ? related.name.trim()
          : "";
        if (
          !related
          || !Number.isSafeInteger(relatedId)
          || relatedId <= 0
          || !relatedName
        ) {
          throw new Error(
            `剧本列表第 ${index + 1} 条记录的第 ${assetIndex + 1} 个关联素材格式无效`,
          );
        }
        return { id: relatedId, name: relatedName };
      }),
    });
  });
}

export default function ScriptPage({ embedded = false, onOpenAssetGeneration }: ScriptPageProps) {
  const navigate = useNavigate();
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const projectId = currentProject?.id ?? currentProjectId;
  const numericProjectId = Number.isSafeInteger(Number(projectId)) && Number(projectId) > 0
    ? Number(projectId)
    : null;
  const [items, setItems] = useState<ScriptItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showBatchAdd, setShowBatchAdd] = useState(false);
  const [editItem, setEditItem] = useState<ScriptItem | null>(null);
  const [selectedScriptIds, setSelectedScriptIds] = useState<number[]>([]);
  const [assetProposal, setAssetProposal] = useState<ScriptAssetProposal | null>(null);
  const [extractingAssets, setExtractingAssets] = useState(false);
  const [extractionElapsedSeconds, setExtractionElapsedSeconds] = useState(0);
  const [extractAssetsError, setExtractAssetsError] = useState("");
  const [extractAssetsErrorCode, setExtractAssetsErrorCode] = useState("");
  const [extractAssetsReferenceId, setExtractAssetsReferenceId] = useState("");
  const [refreshingExtractionStatus, setRefreshingExtractionStatus] = useState(false);
  const [confirmingAssets, setConfirmingAssets] = useState(false);
  const [confirmAssetsError, setConfirmAssetsError] = useState("");
  const [confirmAssetsErrorCode, setConfirmAssetsErrorCode] = useState("");
  const [completedAssetExtraction, setCompletedAssetExtraction] = useState<CompletedAssetExtraction | null>(null);
  const [deleteIntent, setDeleteIntent] = useState<ScriptDeleteIntent | null>(null);
  const [deleteError, setDeleteError] = useState<ScriptDeleteError | null>(null);
  const activeProjectIdRef = useRef<number | null>(numericProjectId);
  const fetchEpochRef = useRef(0);
  const deleteIntentRef = useRef<ScriptDeleteIntent | null>(null);
  const extractionAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const persistedExtractionAttemptRef = useRef<PersistedExtractionAttempt | null>(null);
  const confirmationAttemptRef = useRef<StableSubmissionAttempt | null>(null);
  const extractionRequestRef = useRef<PendingRequest | null>(null);
  const extractionStatusRequestRef = useRef<PendingRequest | null>(null);
  const confirmationRequestRef = useRef<PendingRequest | null>(null);
  const proposalCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const proposalReturnFocusRef = useRef<HTMLElement | null>(null);
  activeProjectIdRef.current = numericProjectId;
  const batchExtraction = useScriptAssetBatch(numericProjectId, (proposal) => {
    setAssetProposal(normalizeScriptAssetProposal(proposal));
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
    confirmationAttemptRef.current = null;
  });

  const fetchItems = useCallback(async (options: {
    background?: boolean;
    expectedProjectId?: number;
  } = {}) => {
    const requestedProjectId = options.expectedProjectId ?? numericProjectId;
    if (
      !requestedProjectId
      || requestedProjectId !== numericProjectId
      || activeProjectIdRef.current !== requestedProjectId
    ) return;
    const requestEpoch = ++fetchEpochRef.current;
    const isCurrentRequest = () => (
      activeProjectIdRef.current === requestedProjectId
      && fetchEpochRef.current === requestEpoch
    );
    if (!options.background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const response: unknown = await apiPost("/script/getScrptApi", { projectId: requestedProjectId, name: searchText } as any);
      if (!isCurrentRequest()) return;
      const nextItems = normalizeScriptListResponse(response);
      const availableIds = new Set(nextItems.map((item) => Number(item.id)));
      setItems(nextItems);
      setSelectedScriptIds((current) => current.filter((id) => availableIds.has(id)));
      setLoadError("");
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (!options.background) {
        setLoadError(error instanceof Error ? error.message : "剧本加载失败");
      }
    } finally {
      if (!options.background && isCurrentRequest()) setLoading(false);
    }
  }, [numericProjectId, searchText]);

  useEffect(() => {
    const restoredAttempt = numericProjectId
      ? readPersistedExtractionAttempt(numericProjectId)
      : null;
    fetchEpochRef.current += 1;
    setItems([]);
    setLoading(false);
    setLoadError("");
    setSelectedScriptIds(restoredAttempt?.scriptIds || []);
    setAssetProposal(null);
    setExtractingAssets(false);
    setExtractAssetsError("");
    setExtractAssetsErrorCode("");
    setExtractAssetsReferenceId("");
    setRefreshingExtractionStatus(false);
    setConfirmingAssets(false);
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
    setCompletedAssetExtraction(null);
    extractionAttemptRef.current = restoredAttempt
      ? {
          fingerprint: restoredAttempt.fingerprint,
          idempotencyKey: restoredAttempt.idempotencyKey,
        }
      : null;
    persistedExtractionAttemptRef.current = restoredAttempt;
    confirmationAttemptRef.current = null;
    extractionRequestRef.current = null;
    extractionStatusRequestRef.current = null;
    confirmationRequestRef.current = null;
    proposalReturnFocusRef.current = null;
    deleteIntentRef.current = null;
    setDeleteIntent(null);
    setDeleteError(null);
    if (restoredAttempt) void refreshAssetExtractionStatus(restoredAttempt);
  }, [numericProjectId]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    if (!extractingAssets) {
      setExtractionElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const updateElapsed = () => {
      setExtractionElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [extractingAssets]);

  useEffect(() => {
    if (!numericProjectId || assetProposal || ![
      "script_asset_extraction_pending_reconcile",
      "script_asset_extraction_in_progress",
    ].includes(extractAssetsErrorCode)) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= 10 * 60_000) {
        window.clearInterval(timer);
        setExtractAssetsError("本次提取仍未完成，自动查询已暂停。可刷新处理状态，请勿重复提取");
        return;
      }
      // Only observe the persisted attempt. A lost HTTP response never
      // authorizes another paid POST, even after navigating away and back.
      void refreshAssetExtractionStatus();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [numericProjectId, assetProposal?.proposalId, extractAssetsErrorCode]);

  useEffect(() => {
    if (!assetProposal) return;
    const returnFocus = proposalReturnFocusRef.current
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    proposalReturnFocusRef.current = returnFocus;
    proposalCloseButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || confirmationRequestRef.current) return;
      event.preventDefault();
      closeAssetProposal();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (proposalReturnFocusRef.current === returnFocus) {
        proposalReturnFocusRef.current = null;
        queueMicrotask(() => {
          if (returnFocus?.isConnected) returnFocus.focus();
        });
      }
    };
  }, [assetProposal?.proposalId]);

  function toggleScriptSelection(id: number) {
    setSelectedScriptIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
    if (!extractionStatusRequiresRefresh(extractAssetsErrorCode)) {
      setExtractAssetsError("");
      setExtractAssetsErrorCode("");
    }
  }

  function toggleAllScripts() {
    const visibleIds = items.map((item) => Number(item.id));
    const allSelected = visibleIds.length > 0
      && visibleIds.every((id) => selectedScriptIds.includes(id));
    setSelectedScriptIds(allSelected ? [] : visibleIds);
    if (!extractionStatusRequiresRefresh(extractAssetsErrorCode)) {
      setExtractAssetsError("");
      setExtractAssetsErrorCode("");
    }
  }

  function clearActiveExtractionAttempt(projectId: number) {
    clearPersistedExtractionAttempt(projectId);
    persistedExtractionAttemptRef.current = null;
    extractionAttemptRef.current = null;
  }

  async function refreshAssetExtractionStatus(
    attemptSnapshot = persistedExtractionAttemptRef.current,
  ) {
    if (!attemptSnapshot || extractionStatusRequestRef.current) return;
    const requestedProjectId = attemptSnapshot.projectId;
    if (activeProjectIdRef.current !== requestedProjectId) return;
    const request = { projectId: requestedProjectId, requestToken: crypto.randomUUID() };
    extractionStatusRequestRef.current = request;
    setRefreshingExtractionStatus(true);
    try {
      const response = await apiPost<ExtractionStatus>(
        "/script/extractAssets/status",
        { projectId: requestedProjectId },
        undefined,
        { headers: { "Idempotency-Key": attemptSnapshot.idempotencyKey } },
      );
      if (
        extractionStatusRequestRef.current?.requestToken !== request.requestToken
        || activeProjectIdRef.current !== requestedProjectId
      ) return;
      setExtractAssetsReferenceId(String(response.referenceId || ""));
      if (response.state === "proposal_ready") {
        setAssetProposal(normalizeScriptAssetProposal(response.proposal));
        setExtractAssetsError("");
        setExtractAssetsErrorCode("");
        setConfirmAssetsError("");
        setConfirmAssetsErrorCode("");
        confirmationAttemptRef.current = null;
        return;
      }
      const message = String(response.message || "资产提取状态已更新");
      if (response.state === "retry_allowed") {
        if (response.retryMode === "new_attempt" || response.canStartNewAttempt) {
          clearActiveExtractionAttempt(requestedProjectId);
          setExtractAssetsErrorCode("script_asset_extraction_retry_allowed");
        } else {
          setExtractAssetsErrorCode("script_asset_extraction_retry_allowed_same_attempt");
        }
        setExtractAssetsError(message);
        return;
      }
      if (response.state === "manual_required") {
        // Server diagnostics can be more specific (for example, a missing
        // recovery binding), but every manual state must stay on the guarded
        // refresh path. Treating an unknown diagnostic code as retryable would
        // let the UI POST a new attempt into the same blocked peer again.
        setExtractAssetsErrorCode("script_asset_extraction_manual_required");
        setExtractAssetsError(message);
        return;
      }
      setExtractAssetsErrorCode(response.state === "pending_reconcile"
        ? "script_asset_extraction_pending_reconcile"
        : "script_asset_extraction_in_progress");
      setExtractAssetsError(message);
    } catch (error) {
      if (
        extractionStatusRequestRef.current?.requestToken === request.requestToken
        && activeProjectIdRef.current === requestedProjectId
      ) {
        setExtractAssetsError(error instanceof Error ? error.message : "刷新资产提取状态失败");
      }
    } finally {
      if (extractionStatusRequestRef.current?.requestToken === request.requestToken) {
        extractionStatusRequestRef.current = null;
        if (activeProjectIdRef.current === requestedProjectId) setRefreshingExtractionStatus(false);
      }
    }
  }

  async function requestAssetExtraction() {
    if (!numericProjectId || loading || selectedScriptIds.length === 0 || extractionRequestRef.current) return;
    if (extractionSelectionLimit) return;
    if (batchExtraction.job) return;
    if (extractionPlan.batches.length > 1) {
      clearActiveExtractionAttempt(numericProjectId);
      setAssetProposal(null);
      setExtractAssetsError("");
      setExtractAssetsErrorCode("");
      try { await batchExtraction.start(items.filter((item) => selectedScriptIds.includes(Number(item.id)))); }
      catch (error) { setExtractAssetsError(error instanceof Error ? error.message : "批处理启动失败"); }
      return;
    }
    const requestedProjectId = numericProjectId;
    const payload = {
      projectId: requestedProjectId,
      scriptIds: [...selectedScriptIds].sort((a, b) => a - b),
    };
    const attempt = resolveStableSubmissionAttempt(
      extractionAttemptRef.current,
      `script-assets-extract:${requestedProjectId}`,
      {
        ...payload,
        scriptContentFingerprint: payload.scriptIds.map((id) => ({
          id,
          name: String(items.find((item) => Number(item.id) === id)?.title || ""),
          contentFingerprint: compactScriptContentFingerprint(
            String(items.find((item) => Number(item.id) === id)?.content || ""),
          ),
        })),
      },
    );
    extractionAttemptRef.current = attempt;
    const persistedAttempt: PersistedExtractionAttempt = {
      version: 1,
      projectId: requestedProjectId,
      scriptIds: payload.scriptIds,
      ...attempt,
    };
    persistedExtractionAttemptRef.current = persistedAttempt;
    persistExtractionAttempt(persistedAttempt);
    const request = {
      projectId: requestedProjectId,
      requestToken: crypto.randomUUID(),
    };
    extractionRequestRef.current = request;
    setExtractingAssets(true);
    setExtractAssetsError("");
    setExtractAssetsErrorCode("");
    try {
      const response = await apiPost<unknown>(
        "/script/extractAssets",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      if (
        extractionRequestRef.current?.requestToken !== request.requestToken
        || activeProjectIdRef.current !== requestedProjectId
      ) return;
      setAssetProposal(normalizeScriptAssetProposal(response));
      setConfirmAssetsError("");
      setConfirmAssetsErrorCode("");
      confirmationAttemptRef.current = null;
    } catch (error) {
      if (
        extractionRequestRef.current?.requestToken === request.requestToken
        && activeProjectIdRef.current === requestedProjectId
      ) {
        const errorCode = error && typeof error === "object"
          ? String((error as { code?: unknown }).code || "")
          : "";
        const httpStatus = error && typeof error === "object"
          ? Number((error as { status?: unknown }).status || 0)
          : 0;
        const responseLost = !errorCode && (httpStatus === 0 || httpStatus >= 500);
        const errorDetails = error && typeof error === "object"
          ? (error as { details?: { referenceId?: unknown } }).details
          : undefined;
        setExtractAssetsReferenceId(String(errorDetails?.referenceId || ""));
        if (
          errorCode === "script_asset_model_output_invalid"
          || errorCode === "script_asset_extraction_retry_allowed"
        ) {
          // The server intentionally terminalizes malformed paid output for
          // this key. A user-initiated retry must therefore be a new attempt.
          clearActiveExtractionAttempt(requestedProjectId);
        }
        setExtractAssetsErrorCode(responseLost ? "script_asset_extraction_pending_reconcile" : errorCode);
        setExtractAssetsError(responseLost
          ? "连接等待中断，正在自动查询本次提取结果，请勿重复提交"
          : error instanceof Error ? error.message : "提取资产失败");
      }
    } finally {
      if (extractionRequestRef.current?.requestToken === request.requestToken) {
        extractionRequestRef.current = null;
        if (activeProjectIdRef.current === requestedProjectId) setExtractingAssets(false);
      }
    }
  }

  function updateProposalAsset(clientId: string, patch: Partial<ExtractedAssetDraft>) {
    setAssetProposal((current) => current ? {
      ...current,
      assets: current.assets.map((asset) => (
        asset.clientId === clientId ? { ...asset, ...patch } : asset
      )),
    } : current);
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
  }

  function toggleProposalAsset(clientId: string) {
    setAssetProposal((current) => {
      if (!current) return current;
      const target = current.assets.find((asset) => asset.clientId === clientId);
      if (!target) return current;
      const selected = !target.selected;
      const affectedIds = new Set([clientId]);
      if (selected) {
        let parentId = target.parentClientId;
        while (parentId && !affectedIds.has(parentId)) {
          const parent = current.assets.find((asset) => asset.clientId === parentId);
          if (!parent || parent.type !== target.type) break;
          affectedIds.add(parentId);
          parentId = parent.parentClientId;
        }
      } else {
        let changed = true;
        while (changed) {
          changed = false;
          for (const asset of current.assets) {
            if (asset.parentClientId && affectedIds.has(asset.parentClientId) && !affectedIds.has(asset.clientId)) {
              affectedIds.add(asset.clientId);
              changed = true;
            }
          }
        }
      }
      return {
        ...current,
        assets: current.assets.map((asset) => (
          affectedIds.has(asset.clientId) ? { ...asset, selected } : asset
        )),
      };
    });
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
  }

  function closeAssetProposal() {
    if (confirmationRequestRef.current) return;
    setAssetProposal(null);
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
    confirmationAttemptRef.current = null;
  }

  async function confirmExtractedAssets() {
    if (!numericProjectId || !assetProposal || confirmationRequestRef.current) return;
    if (scriptAssetProposalHierarchyError(assetProposal.assets)) return;
    const selectedAssets = assetProposal.assets
      .filter((asset) => asset.selected)
      .map(({ selected: _selected, parentClientId, stateLabel, ...asset }) => ({
        ...asset,
        name: asset.name.trim(),
        describe: asset.describe.trim(),
        prompt: asset.prompt.trim(),
        ...(parentClientId?.trim() ? { parentClientId: parentClientId.trim() } : {}),
        ...(stateLabel?.trim() ? { stateLabel: stateLabel.trim() } : {}),
      }));
    if (selectedAssets.length === 0 || selectedAssets.some((asset) => !asset.name)) return;
    const requestedProjectId = numericProjectId;
    const payload = {
      projectId: requestedProjectId,
      proposalId: assetProposal.proposalId,
      assets: selectedAssets,
    };
    const attempt = resolveStableSubmissionAttempt(
      confirmationAttemptRef.current,
      `script-assets-confirm:${requestedProjectId}`,
      payload,
    );
    confirmationAttemptRef.current = attempt;
    const request = {
      projectId: requestedProjectId,
      requestToken: crypto.randomUUID(),
    };
    confirmationRequestRef.current = request;
    setConfirmingAssets(true);
    setConfirmAssetsError("");
    setConfirmAssetsErrorCode("");
    try {
      const response = await apiPost(
        "/script/extractAssets/confirm",
        payload,
        undefined,
        { headers: { "Idempotency-Key": attempt.idempotencyKey } },
      );
      if (
        confirmationRequestRef.current?.requestToken !== request.requestToken
        || activeProjectIdRef.current !== requestedProjectId
      ) return;
      const savedAssetIds = normalizeSavedAssetIds(response);
      setAssetProposal(null);
      setSelectedScriptIds([]);
      setCompletedAssetExtraction({ projectId: requestedProjectId, savedAssetIds });
      if (batchExtraction.job?.mergedProposalId === assetProposal.proposalId) batchExtraction.clear();
      confirmationAttemptRef.current = null;
      clearActiveExtractionAttempt(requestedProjectId);
      void fetchItems({ background: true, expectedProjectId: requestedProjectId });
    } catch (error) {
      if (
        confirmationRequestRef.current?.requestToken === request.requestToken
        && activeProjectIdRef.current === requestedProjectId
      ) {
        setConfirmAssetsErrorCode(error && typeof error === "object"
          ? String((error as { code?: unknown }).code || "")
          : "");
        setConfirmAssetsError(error instanceof Error ? error.message : "资产保存失败");
      }
    } finally {
      if (confirmationRequestRef.current?.requestToken === request.requestToken) {
        confirmationRequestRef.current = null;
        if (activeProjectIdRef.current === requestedProjectId) setConfirmingAssets(false);
      }
    }
  }

  function openDelete(item: ScriptItem) {
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !numericProjectId) return;
    const payload = { projectId: numericProjectId, ids: [id] };
    const attempt = resolveStableSubmissionAttempt(
      null,
      `script-delete:${numericProjectId}`,
      payload,
    );
    const nextIntent = {
      projectId: numericProjectId,
      id,
      title: item.title || item.name || "未命名剧本",
      intentToken: crypto.randomUUID(),
      idempotencyKey: attempt.idempotencyKey,
    };
    deleteIntentRef.current = nextIntent;
    setDeleteError(null);
    setDeleteIntent(nextIntent);
  }

  function isCurrentDeleteIntent(intent: ScriptDeleteIntent | null): intent is ScriptDeleteIntent {
    return Boolean(
      intent
      && deleteIntentRef.current?.intentToken === intent.intentToken
      && deleteIntentRef.current.projectId === intent.projectId
      && activeProjectIdRef.current === intent.projectId,
    );
  }

  function closeDeleteIntent(intentToken: string) {
    if (deleteIntentRef.current?.intentToken !== intentToken) return;
    deleteIntentRef.current = null;
    setDeleteIntent((current) => current?.intentToken === intentToken ? null : current);
    setDeleteError((current) => current?.intentToken === intentToken ? null : current);
  }

  function reportDeleteError(intent: ScriptDeleteIntent | null, error: unknown) {
    if (!isCurrentDeleteIntent(intent)) return;
    setDeleteError({
      intentToken: intent.intentToken,
      message: error instanceof Error ? error.message : "剧本删除失败",
    });
  }

  async function confirmDeleteScript(intent: ScriptDeleteIntent | null) {
    if (!isCurrentDeleteIntent(intent)) return false;
    await apiPost(
      "/script/delScript",
      { projectId: intent.projectId, ids: [intent.id] },
      undefined,
      { headers: { "Idempotency-Key": intent.idempotencyKey } },
    );
    if (!isCurrentDeleteIntent(intent)) return false;
    setItems((current) => (
      activeProjectIdRef.current === intent.projectId
        ? current.filter((item) => Number(item.id) !== intent.id)
        : current
    ));
    setSelectedScriptIds((current) => current.filter((id) => id !== intent.id));
    void fetchItems({ background: true, expectedProjectId: intent.projectId });
    return true;
  }

  const totalCharacters = useMemo(
    () => items.reduce((sum, item) => sum + String(item.content || "").length, 0),
    [items],
  );
  const allScriptsSelected = items.length > 0
    && items.every((item) => selectedScriptIds.includes(Number(item.id)));
  const extractionPlan = useMemo(() => {
    try { return { batches: planScriptAssetBatches(items.filter((item) => selectedScriptIds.includes(Number(item.id)))), error: "" }; }
    catch (error) { return { batches: [], error: error instanceof Error ? error.message : "无法规划提取批次" }; }
  }, [items, selectedScriptIds]);
  const extractionSelectionLimit = extractionPlan.error;
  const batchCompleted = batchExtraction.job?.batches.filter((batch) => batch.proposalId).length || 0;
  const selectedProposalAssets = assetProposal?.assets.filter((asset) => asset.selected) || [];
  const proposalHasInvalidSelection = selectedProposalAssets.some((asset) => !asset.name.trim());
  const proposalHierarchyError = assetProposal
    ? scriptAssetProposalHierarchyError(assetProposal.assets)
    : "";
  const extractionNeedsStatusRefresh = extractionStatusRequiresRefresh(extractAssetsErrorCode);
  const extractionStartsNewAttempt = extractAssetsErrorCode === "script_asset_extraction_retry_allowed";
  const content = (
    <section data-testid={embedded ? "quick-script-page" : undefined} className={`writingWorkspaceContent ${embedded ? "embedded" : ""}`}>
      <section className="writingWorkspaceOverview" aria-labelledby="script-workspace-heading">
        <span className="writingWorkspaceOverviewIcon">
          <FilePenLine size={25} aria-hidden="true" />
        </span>
        <div className="writingWorkspaceOverviewCopy">
          <span>分集与场次</span>
          <h2 id="script-workspace-heading">把故事整理成可以直接生产的剧本</h2>
          <p>统一管理分集、场次与对白文本，后续角色场景和分镜工作都会沿用这里的内容。</p>
        </div>
        <div className="writingWorkspaceMetrics" aria-label="剧本数据概览">
          <div className="writingWorkspaceMetric"><strong>{items.length}</strong><span>剧本</span></div>
          <div className="writingWorkspaceMetric"><strong>{totalCharacters.toLocaleString("zh-CN")}</strong><span>正文字符</span></div>
          <div className="writingWorkspaceMetric"><strong>{items.length}</strong><span>可编辑场次</span></div>
        </div>
      </section>

      <div className="writingWorkspaceToolbar">
        <div className="writingWorkspaceActionGroup">
          {embedded ? (
            <button data-testid="script-add-button" type="button" onClick={() => setShowAdd(true)}>
              <Plus size={16} aria-hidden="true" />
              新增剧本
            </button>
          ) : null}
          <button data-testid="script-batch-add-button" type="button" onClick={() => setShowBatchAdd(true)}>
            <Files size={16} aria-hidden="true" />
            批量导入
          </button>
          <button
            data-testid="script-extract-assets-button"
            type="button"
            disabled={
              loading
              || !selectedScriptIds.length
              || extractingAssets
              || refreshingExtractionStatus
              || extractionNeedsStatusRefresh
              || Boolean(extractionSelectionLimit)
              || Boolean(batchExtraction.job)
            }
            onClick={(event) => {
              proposalReturnFocusRef.current = event.currentTarget;
              void requestAssetExtraction();
            }}
            aria-describedby="script-extraction-limits"
          >
            {extractingAssets ? <Loader2 className="jimengSpin" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
            {extractingAssets ? "正在提取资产…" : `${extractionPlan.batches.length > 1 ? "批量提取资产" : "提取资产"}${selectedScriptIds.length ? `（${selectedScriptIds.length}）` : ""}`}
          </button>
        </div>
        <div className="writingWorkspaceSearchGroup">
          <label className="writingWorkspaceSearch">
            <Search size={16} aria-hidden="true" />
            <input
              data-testid="script-search-input"
              aria-label="搜索剧本"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索剧本名称"
            />
          </label>
          <button className="writingWorkspaceIconAction" type="button" aria-label="刷新剧本列表" onClick={() => void fetchItems()}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <p id="script-extraction-limits" role={extractionSelectionLimit || extractionPlan.batches.length > 1 ? "status" : undefined}
        style={{ margin: "0 0 12px", fontSize: 13, color: `var(--cui-${extractionSelectionLimit ? "warning-text" : "text-secondary"})` }}>
        {extractionSelectionLimit || (extractionPlan.batches.length > 1
          ? `已选 ${selectedScriptIds.length} 条剧本，将自动分为 ${extractionPlan.batches.length} 批依次提取，完成后统一审核。`
          : "支持整部剧批量提取，系统按每批最多 20 条、12 万字自动拆分。完成后统一审核资产。")}
      </p>

      {batchExtraction.job ? <section className="scriptBatchProgress" aria-label="资产批处理进度" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 16, marginBottom: 16, background: "var(--surface-raised)" }}>
        <strong>已完成 {batchCompleted} / {batchExtraction.job.batches.length} 批 · 共 {batchExtraction.job.batches.reduce((sum, batch) => sum + batch.scriptIds.length, 0)} 条剧本</strong>
        <progress className="scriptBatchProgressBar" aria-label="已完成批次" max={batchExtraction.job.batches.length} value={batchCompleted} />
        <p role="status" style={{ margin: "0 0 8px", fontSize: 13 }}>{batchExtraction.job.message}</p>
        {batchExtraction.job.referenceId ? <small>请求编号：{batchExtraction.job.referenceId}</small> : null}
        <p style={{ fontSize: 12, color: "var(--text-200)", margin: "8px 0" }}>每批按实际模型用量计费。离开本页会暂停后续批次，返回此标签页可继续；已完成结果不会重跑。</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {batchExtraction.job.phase === "running"
            ? <button className="writingWorkspaceSecondaryAction" type="button" onClick={batchExtraction.pause}>当前批次后暂停</button>
            : <>
              <button className="writingWorkspacePrimaryAction" type="button" disabled={confirmingAssets} onClick={() => void batchExtraction.resume()}>{batchExtraction.job.phase === "ready" ? "审核汇总资产" : "继续未完成批次"}</button>
              {batchExtraction.job.phase !== "ready" ? <button className="writingWorkspaceSecondaryAction" type="button" onClick={() => void batchExtraction.refresh()}>刷新当前批次状态</button> : null}
              <button className="writingWorkspaceSecondaryAction" type="button" disabled={confirmingAssets} onClick={() => {
                if (window.confirm("结束批处理会清除本浏览器的续跑进度；已完成调用的费用不会撤销，已保存资产不受影响。确定结束？")) {
                  batchExtraction.clear();
                  closeAssetProposal();
                }
              }}>结束批处理</button>
            </>}
        </div>
      </section> : null}

      {extractAssetsError ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
            padding: "10px 12px",
            border: `1px solid var(--cui-${extractionNeedsStatusRefresh ? "warning" : "danger"}-border)`,
            borderRadius: "var(--cui-radius-md, 8px)",
            background: `var(--cui-${extractionNeedsStatusRefresh ? "warning" : "danger"}-bg)`,
            color: `var(--cui-${extractionNeedsStatusRefresh ? "warning" : "danger"}-text)`,
          }}
        >
          <span>
            {extractionNeedsStatusRefresh ? "资产提取状态：" : "提取资产失败："}
            {extractAssetsError}
            {extractAssetsReferenceId ? <small style={{ display: "block", marginTop: 4 }}>请求编号：{extractAssetsReferenceId}</small> : null}
          </span>
          {extractionNeedsStatusRefresh ? (
            <button
              type="button"
              disabled={refreshingExtractionStatus}
              onClick={() => void refreshAssetExtractionStatus()}
            >
              {refreshingExtractionStatus ? "正在刷新…" : "刷新处理状态"}
            </button>
          ) : (
            <button
              type="button"
              disabled={extractingAssets || Boolean(extractionSelectionLimit)}
              onClick={() => void requestAssetExtraction()}
            >
              {extractionStartsNewAttempt ? "重新提取资产" : "重试提取资产"}
            </button>
          )}
        </div>
      ) : null}

      {extractingAssets ? (
        <div role="status" style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid #bfdbfe", borderRadius: 8, background: "#eff6ff", color: "#1e40af" }}>
          提取请求已提交，已等待 {extractionElapsedSeconds} 秒。文本模型可能需要几分钟；可以离开本步骤，完成后返回会自动恢复待审核提案。
        </div>
      ) : null}

      {completedAssetExtraction ? (
        <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12, padding: "10px 12px", border: "1px solid #bbf7d0", borderRadius: 8, background: "#f0fdf4", color: "#166534" }}>
          <span>已保存 {completedAssetExtraction.savedAssetIds.length} 个资产，未自动发起任何付费生成。</span>
          <button
            type="button"
            onClick={() => {
              if (embedded && onOpenAssetGeneration) {
                onOpenAssetGeneration([...completedAssetExtraction.savedAssetIds]);
                return;
              }
              navigate("/workbench/corner-scape", {
                state: {
                  projectId: completedAssetExtraction.projectId,
                  savedAssetIds: [...completedAssetExtraction.savedAssetIds],
                },
              });
            }}
          >
            前往资产生成（{completedAssetExtraction.savedAssetIds.length}）
          </button>
        </div>
      ) : null}

      <div className="writingWorkspaceTableShell">
        <table className="writingWorkspaceTable" data-testid="script-table">
          <thead>
            <tr>
              <th className="centerCell" style={{ width: 48 }}>
                <input
                  type="checkbox"
                  aria-label="选择全部剧本"
                  checked={allScriptsSelected}
                  onChange={toggleAllScripts}
                />
              </th>
              <th>剧本</th>
              <th className="numericCell">正文字符</th>
              <th className="centerCell">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4}><div className="writingWorkspaceState"><Loader2 className="jimengSpin" size={24} /><strong>正在载入剧本</strong></div></td></tr>
            ) : loadError ? (
              <tr><td colSpan={4}><div className="writingWorkspaceState error"><RefreshCw size={24} /><strong>加载失败</strong><p>{loadError}</p><button type="button" onClick={() => void fetchItems()}>重试</button></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={4}><div className="writingWorkspaceState"><FilePenLine size={28} /><strong>{searchText ? "没有匹配的剧本" : "还没有剧本"}</strong><p>{searchText ? "换一个关键词试试。" : "新增或导入剧本，再勾选剧本提取角色、场景、道具和状态变体。"}</p></div></td></tr>
            ) : items.map((item) => (
              <tr key={item.id} data-testid="script-row" data-script-id={String(item.id)}>
                <td className="centerCell">
                  <input
                    type="checkbox"
                    aria-label={`选择剧本 ${item.title || item.name || "未命名"}`}
                    checked={selectedScriptIds.includes(Number(item.id))}
                    onChange={() => toggleScriptSelection(Number(item.id))}
                  />
                </td>
                <td className="titleCell" title={item.content || ""}>{item.title || "未命名"}</td>
                <td className="numericCell">{String(item.content || "").length.toLocaleString("zh-CN")}</td>
                <td className="centerCell">
                  <button className="writingWorkspaceTextButton" data-testid="script-edit-button" type="button" onClick={() => setEditItem(item)}>编辑</button>
                  <button
                    className="writingWorkspaceTextButton"
                    type="button"
                    aria-label={`删除剧本 ${item.title || item.name || "未命名"}`}
                    onClick={() => openDelete(item)}
                    style={{ marginLeft: 8, color: "#b23a32" }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  const dialogs = (
    <>
      {showAdd ? <AddScript open onClose={() => { setShowAdd(false); void fetchItems(); }} projectId={projectId || undefined} /> : null}
      {showBatchAdd ? <BatchAddScript open onClose={() => { setShowBatchAdd(false); void fetchItems(); }} projectId={projectId || undefined} /> : null}
      {editItem ? <EditScript open item={editItem} onClose={() => { setEditItem(null); void fetchItems(); }} /> : null}
      {assetProposal ? (
        <div
          className="scriptAssetProposalBackdrop"
          onClick={closeAssetProposal}
          style={{ position: "fixed", inset: 0, zIndex: 10020, display: "grid", placeItems: "center", padding: 24 }}
        >
          <section
            className="scriptAssetProposalDialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认提取资产"
            onClick={(event) => event.stopPropagation()}
            style={{ width: "min(980px, 100%)", maxHeight: "min(820px, calc(100vh - 48px))", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", overflow: "hidden", borderRadius: 14 }}
          >
            <header className="scriptAssetProposalHeader" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "20px 22px 16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 20 }}>确认提取资产</h3>
                <p className="scriptAssetProposalMuted" style={{ margin: "6px 0 0", fontSize: 13 }}>这里是待审核提案；只有勾选并点击确认后才会写入项目资产。</p>
              </div>
              <button ref={proposalCloseButtonRef} className="scriptAssetProposalClose" type="button" aria-label="关闭资产提案" disabled={confirmingAssets} onClick={closeAssetProposal}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>

            <div className="scriptAssetProposalBody" style={{ display: "grid", gap: 12, padding: 20, overflowY: "auto" }}>
              {assetProposal.assets.length === 0 ? (
                <div className="scriptAssetProposalMuted" style={{ padding: 28, textAlign: "center" }}>剧本中没有识别到可确认的资产。</div>
              ) : assetProposal.assets.map((asset) => {
                const currentParent = asset.parentClientId
                  ? assetProposal.assets.find((candidate) => candidate.clientId === asset.parentClientId)
                  : null;
                const currentParentIsValid = !asset.parentClientId || Boolean(
                  currentParent
                  && !currentParent.parentClientId
                  && currentParent.type === asset.type,
                );
                return (
                <article className="scriptAssetProposalCard" data-selected={asset.selected ? "true" : "false"} key={asset.clientId} style={{ display: "grid", gap: 12, padding: 16, borderRadius: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 650 }}>
                      <input
                        data-testid={`proposal-asset-select-${asset.clientId}`}
                        type="checkbox"
                        aria-label={`保存资产 ${asset.name}`}
                        checked={asset.selected}
                        disabled={confirmingAssets}
                        onChange={() => toggleProposalAsset(asset.clientId)}
                      />
                      <span>{extractedAssetTypeLabels[asset.type]}·{asset.stateLabel || "基础资产"}</span>
                    </label>
                    {asset.parentClientId ? <small className="scriptAssetProposalMuted">状态变体</small> : null}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 0.7fr) minmax(180px, 1fr) minmax(180px, 1fr)", gap: 10 }}>
                    <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                      类型
                      <select
                        data-testid={`proposal-asset-type-${asset.clientId}`}
                        aria-label={`资产类型 ${asset.name}`}
                        value={asset.type}
                        disabled
                        style={{ minWidth: 0, padding: 8 }}
                      >
                        <option value="role">角色</option>
                        <option value="scene">场景</option>
                        <option value="tool">道具</option>
                      </select>
                    </label>
                    <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                      名称
                      <input
                        data-testid={`proposal-asset-name-${asset.clientId}`}
                        value={asset.name}
                        disabled={!asset.selected || confirmingAssets}
                        onChange={(event) => updateProposalAsset(asset.clientId, { name: event.target.value })}
                        style={{ minWidth: 0, padding: 8 }}
                      />
                    </label>
                    <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                      状态标签（可选）
                      <input
                        data-testid={`proposal-asset-state-${asset.clientId}`}
                        value={asset.stateLabel || ""}
                        disabled={!asset.selected || confirmingAssets}
                        placeholder="例如：雨战、受伤、少年时期"
                        onChange={(event) => updateProposalAsset(asset.clientId, { stateLabel: event.target.value })}
                        style={{ minWidth: 0, padding: 8 }}
                      />
                    </label>
                  </div>

                  <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                    基础资产（由提取结果确定）
                    <select
                      data-testid={`proposal-asset-parent-${asset.clientId}`}
                      aria-label={`基础资产 ${asset.name}`}
                      value={asset.parentClientId || ""}
                      disabled
                      style={{ padding: 8 }}
                    >
                      <option value="">无，这是独立基础资产</option>
                      {!currentParentIsValid && asset.parentClientId ? (
                        <option value={asset.parentClientId} disabled>无效基础资产引用</option>
                      ) : null}
                      {currentParentIsValid && currentParent ? (
                        <option value={currentParent.clientId}>{currentParent.name}</option>
                      ) : null}
                    </select>
                  </label>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                      视觉描述
                      <textarea value={asset.describe} rows={3} disabled={!asset.selected || confirmingAssets} onChange={(event) => updateProposalAsset(asset.clientId, { describe: event.target.value })} style={{ padding: 8, resize: "vertical" }} />
                    </label>
                    <label className="scriptAssetProposalField" style={{ display: "grid", gap: 5, fontSize: 12 }}>
                      图片提示词
                      <textarea value={asset.prompt} rows={3} disabled={!asset.selected || confirmingAssets} onChange={(event) => updateProposalAsset(asset.clientId, { prompt: event.target.value })} style={{ padding: 8, resize: "vertical" }} />
                    </label>
                  </div>
                </article>
                );
              })}
            </div>

            <footer className="scriptAssetProposalFooter" style={{ display: "grid", gap: 10, padding: "14px 20px 18px" }}>
              {confirmAssetsError ? (
                <div role="alert" className="scriptAssetProposalError" style={{ fontSize: 13 }}>
                  保存失败：{confirmAssetsError}
                  {confirmAssetsErrorCode === "script_asset_proposal_stale" ? " 请关闭提案并重新提取。" : null}
                  {confirmAssetsErrorCode === "script_asset_proposal_already_confirmed" ? " 该提案已完成，请关闭后刷新资产列表。" : null}
                </div>
              ) : null}
              {proposalHierarchyError ? <div className="scriptAssetProposalWarning" style={{ fontSize: 13 }}>{proposalHierarchyError}</div> : null}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span className="scriptAssetProposalMuted" style={{ fontSize: 13 }}>已选 {selectedProposalAssets.length} / {assetProposal.assets.length}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="scriptAssetProposalCancel" type="button" disabled={confirmingAssets} onClick={closeAssetProposal} style={{ padding: "8px 14px" }}>取消</button>
                  {confirmAssetsErrorCode !== "script_asset_proposal_stale"
                    && confirmAssetsErrorCode !== "script_asset_proposal_already_confirmed" ? (
                      <button
                        className="scriptAssetProposalConfirm"
                        type="button"
                        disabled={confirmingAssets || selectedProposalAssets.length === 0 || proposalHasInvalidSelection || Boolean(proposalHierarchyError)}
                        onClick={() => void confirmExtractedAssets()}
                        style={{ padding: "8px 14px", border: 0, borderRadius: 8 }}
                      >
                        {confirmingAssets ? "保存中…" : confirmAssetsError ? "重试保存" : "确认保存所选资产"}
                      </button>
                    ) : null}
                </div>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
      <ConfirmDialog
        key={deleteIntent?.intentToken || "script-delete-dialog"}
        open={Boolean(deleteIntent)}
        title="删除剧本？"
        description={(
          <>
            <span>将剧本「{deleteIntent?.title || "未命名"}」从当前项目移除，创作库媒体与计费审计保留。该剧本下的分镜、轨道和项目内视频记录也会一起移除。</span>
            {deleteError && deleteError.intentToken === deleteIntent?.intentToken ? <span role="alert" style={{ display: "block", marginTop: 8, color: "#b91c1c" }}>删除失败：{deleteError.message}</span> : null}
          </>
        )}
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={() => confirmDeleteScript(deleteIntent)}
        onConfirmError={(error) => reportDeleteError(deleteIntent, error)}
        onCancel={() => deleteIntent && closeDeleteIntent(deleteIntent.intentToken)}
      />
    </>
  );

  if (embedded) return <>{content}{dialogs}</>;

  return (
    <WritingWorkspaceFrame
      active="script"
      eyebrow="故事创作"
      title="剧本工作台"
      description="管理分集、场次与对白文本"
      actionLabel="新增剧本"
      actionTestId="script-add-button"
      actionIcon={Plus}
      onAction={() => setShowAdd(true)}
    >
      {content}
      {dialogs}
    </WritingWorkspaceFrame>
  );
}
