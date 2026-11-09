import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { positiveCanvasRevision, positiveCanvasProjectId } from "./canvasSnapshotCodec";
import { readLoadedCanvasIdentity } from "./canvasLoadedIdentity";
import type { NodeData, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import { api, type CanvasShareRecord, type FjtvPublicationRecord } from "@/lib/api";
import { toApiErrorView } from "@/api/http";

export interface CanvasPublicationControllerDependencies {
  closeBottomPanels: () => void;
  setProjectMenuOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasSwitcherOpen: Dispatch<SetStateAction<boolean>>;
  setCanvasShareOverlay: Dispatch<SetStateAction<"menu" | "pointsPopover" | "user" | null>>;
  canvasShareTriggerRef: RefObject<HTMLButtonElement | null>;
  activeProjectContextId: string | null;
  canvasMeta: CanvasMetaState;
  canvasPublicationAttemptRef: RefObject<Record<"share" | "fjtv", { scope: string; key: string; } | null>>;
  setCanvasShares: Dispatch<SetStateAction<CanvasShareRecord[]>>;
  setFjtvPublications: Dispatch<SetStateAction<FjtvPublicationRecord[]>>;
  setCanvasPublicationError: Dispatch<SetStateAction<string | null>>;
  setCanvasPublicationLoading: Dispatch<SetStateAction<boolean>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  nodesRef: RefObject<NodeData[]>;
  edges: EdgeData[];
  groups: GroupData[];
  routeProjectContextId: string | number | null | undefined;
  setCanvasPublicationBusy: Dispatch<SetStateAction<"share" | "fjtv" | "revoke" | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  canvasCoverUrl: (nextNodes: NodeData[]) => string;
}

export function createCanvasPublicationController(deps: CanvasPublicationControllerDependencies) {
  const { closeBottomPanels, setProjectMenuOpen, setCanvasSwitcherOpen, setCanvasShareOverlay, canvasShareTriggerRef, activeProjectContextId, canvasMeta, canvasPublicationAttemptRef, setCanvasShares, setFjtvPublications, setCanvasPublicationError, setCanvasPublicationLoading, persistCanvas, nodesRef, edges, groups, routeProjectContextId, setCanvasPublicationBusy, setStatus, canvasCoverUrl } = deps;
function openCanvasShareMenu() {
    closeBottomPanels();
    setProjectMenuOpen(false);
    setCanvasSwitcherOpen(false);
    setCanvasShareOverlay((prev) => (prev === "menu" ? null : "menu"));
  }

function closeCanvasShareOverlay({ restoreFocus = true } = {}) {
    setCanvasShareOverlay(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => canvasShareTriggerRef.current?.focus({ preventScroll: true }));
    }
  }

function currentCanvasPublicationScope() {
    const projectId = positiveCanvasProjectId(activeProjectContextId);
    const canvasId = positiveCanvasProjectId(canvasMeta.canvasId);
    if (!projectId || !canvasId) return null;
    return { projectId: Number(projectId), canvasId: Number(canvasId) };
  }

function canvasPublicationAttempt(kind: "share" | "fjtv", revision: number) {
    const scope = `${kind}:${canvasMeta.canvasId || "canvas"}:${revision}`;
    const existing = canvasPublicationAttemptRef.current[kind];
    if (existing?.scope === scope) return existing.key;
    const random = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const next = { scope, key: `canvas-${kind}:${random}` };
    canvasPublicationAttemptRef.current[kind] = next;
    return next.key;
  }

async function refreshCanvasPublications() {
    const scope = currentCanvasPublicationScope();
    if (!scope) {
      setCanvasShares([]);
      setFjtvPublications([]);
      setCanvasPublicationError("请先保存当前画布");
      return;
    }
    setCanvasPublicationLoading(true);
    setCanvasPublicationError(null);
    try {
      const [shareResult, fjtvResult] = await Promise.all([
        api.listCanvasShares(scope.projectId, scope.canvasId),
        api.listCanvasFjtvSubmissions(scope.projectId, scope.canvasId),
      ]);
      setCanvasShares(shareResult.shares || []);
      setFjtvPublications(fjtvResult.publications || []);
    } catch (error) {
      setCanvasPublicationError(toApiErrorView(error).message || "发布状态加载失败");
    } finally {
      setCanvasPublicationLoading(false);
    }
  }

async function authoritativeCanvasPublicationIdentity() {
    const scope = currentCanvasPublicationScope();
    if (!scope) throw new Error("请先保存当前画布");
    await persistCanvas(nodesRef.current, edges, canvasMeta.name, groups);
    const latest = await api.loadCanvas(String(scope.canvasId));
    const identity = readLoadedCanvasIdentity(latest, String(scope.canvasId), routeProjectContextId, positiveCanvasProjectId, positiveCanvasRevision);
    return {
      projectId: Number(identity.projectId),
      canvasId: Number(identity.canvasId),
      expectedRevision: identity.revision,
    };
  }

function publicCanvasShareUrl(slug: string) {
    return `${window.location.origin}/#/share/canvas/${encodeURIComponent(slug)}`;
  }

function publicFjtvUrl(slug: string) {
    return `${window.location.origin}/#/fjtv/${encodeURIComponent(slug)}`;
  }

async function createPublicCanvasShare() {
    setCanvasPublicationBusy("share");
    setCanvasPublicationError(null);
    try {
      const identity = await authoritativeCanvasPublicationIdentity();
      const result = await api.createCanvasShare({
        ...identity,
        title: canvasMeta.name,
        idempotencyKey: canvasPublicationAttempt("share", identity.expectedRevision),
      });
      canvasPublicationAttemptRef.current.share = null;
      setCanvasShares((previous) => [result.share, ...previous.filter((item) => item.id !== result.share.id)]);
      const url = publicCanvasShareUrl(result.share.slug);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setStatus("分享链接已创建并复制");
    } catch (error) {
      setCanvasPublicationError(toApiErrorView(error).message || "创建分享失败");
    } finally {
      setCanvasPublicationBusy(null);
    }
  }

async function submitCurrentCanvasToFjtv() {
    setCanvasPublicationBusy("fjtv");
    setCanvasPublicationError(null);
    try {
      const identity = await authoritativeCanvasPublicationIdentity();
      const result = await api.submitCanvasToFjtv({
        ...identity,
        title: canvasMeta.name,
        description: "来自繁境画布的作品投稿",
        coverUrl: canvasCoverUrl(nodesRef.current) || null,
        idempotencyKey: canvasPublicationAttempt("fjtv", identity.expectedRevision),
      });
      canvasPublicationAttemptRef.current.fjtv = null;
      setFjtvPublications((previous) => [
        result.publication,
        ...previous.filter((item) => item.id !== result.publication.id),
      ]);
      setStatus("FJTV 投稿已提交，审核通过后公开");
    } catch (error) {
      setCanvasPublicationError(toApiErrorView(error).message || "FJTV 投稿失败");
    } finally {
      setCanvasPublicationBusy(null);
    }
  }

async function revokePublicCanvasShare(share: CanvasShareRecord) {
    const scope = currentCanvasPublicationScope();
    if (!scope) return;
    setCanvasPublicationBusy("revoke");
    setCanvasPublicationError(null);
    try {
      const result = await api.revokeCanvasShare(scope.projectId, share.id, share.revision);
      setCanvasShares((previous) => previous.map((item) => (
        item.id === result.share.id ? result.share : item
      )));
      setStatus("分享链接已撤销");
    } catch (error) {
      setCanvasPublicationError(toApiErrorView(error).message || "撤销分享失败");
    } finally {
      setCanvasPublicationBusy(null);
    }
  }
  return { openCanvasShareMenu, closeCanvasShareOverlay, currentCanvasPublicationScope, canvasPublicationAttempt, refreshCanvasPublications, authoritativeCanvasPublicationIdentity, publicCanvasShareUrl, publicFjtvUrl, createPublicCanvasShare, submitCurrentCanvasToFjtv, revokePublicCanvasShare };
}
