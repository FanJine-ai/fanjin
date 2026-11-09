import type * as React from "react";
import type * as Router from "react-router-dom";
import { getActiveCanvasShares, getCanvasPublicationStatusLabel } from "./canvasPublicationViewModel";
import { CanvasPointsPopover } from "./CanvasPointsPopover";
import { CanvasAccountMenu } from "./CanvasAccountMenu";
import { CanvasPublicationMenu } from "./CanvasPublicationMenu";
import { createPortal } from "react-dom";
import { type CanvasRealCapabilities } from "./canvasCapabilities";
import { type CanvasShareRecord, type FjtvPublicationRecord } from "@/lib/api";

export interface CanvasPageHeaderProps {
  studioChrome: boolean;
  studioProjectHeaderInAgent: boolean;
  studioProjectHeaderPortalTarget: HTMLElement | null;
  renderProjectHeaderCluster: () => React.JSX.Element;
  renderStudioHeaderActions: () => React.JSX.Element | null;
  canvasShareOverlay: "user" | "menu" | "pointsPopover" | null;
  canvasSharePopoverRef: React.RefObject<HTMLDivElement | null>;
  canvasPublicationError: string | null;
  canvasPublicationBusy: "share" | "fjtv" | "revoke" | null;
  canvasCapabilities: CanvasRealCapabilities;
  submitCurrentCanvasToFjtv: () => Promise<void>;
  createPublicCanvasShare: () => Promise<void>;
  fjtvPublications: FjtvPublicationRecord[];
  publicFjtvUrl: (slug: string) => string;
  canvasPublicationLoading: boolean;
  canvasShares: CanvasShareRecord[];
  publicCanvasShareUrl: (slug: string) => string;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  revokePublicCanvasShare: (share: CanvasShareRecord) => Promise<void>;
  accountBalanceLabel: string;
  canvasBalance: { refresh: () => void; loading: boolean; error: string; availableMicros: number; reservedMicros: number; baselineMicros: number; spentMicros: number; percent: number; lastRechargeAt: number | null; };
  navigateFromCanvasPanel: (path: string) => void;
  setCanvasShareOverlay: React.Dispatch<React.SetStateAction<"user" | "menu" | "pointsPopover" | null>>;
  accountProfile: { displayName: any; avatarUrl: any; userId: any; initial: string; };
  canvasColorMode: import("@/ui/theme").ThemeMode;
  switchCanvasColorMode: (m: import("@/ui/theme").ThemeMode) => void;
  handleCanvasLogout: () => void;
}
export function CanvasPageHeader({
  studioChrome,
  studioProjectHeaderInAgent,
  studioProjectHeaderPortalTarget,
  renderProjectHeaderCluster,
  renderStudioHeaderActions,
  canvasShareOverlay,
  canvasSharePopoverRef,
  canvasPublicationError,
  canvasPublicationBusy,
  canvasCapabilities,
  submitCurrentCanvasToFjtv,
  createPublicCanvasShare,
  fjtvPublications,
  publicFjtvUrl,
  canvasPublicationLoading,
  canvasShares,
  publicCanvasShareUrl,
  setStatus,
  revokePublicCanvasShare,
  accountBalanceLabel,
  canvasBalance,
  navigateFromCanvasPanel,
  setCanvasShareOverlay,
  accountProfile,
  canvasColorMode,
  switchCanvasColorMode,
  handleCanvasLogout,
}: CanvasPageHeaderProps) {
  return <>
{studioChrome && studioProjectHeaderInAgent && studioProjectHeaderPortalTarget
        ? createPortal(renderProjectHeaderCluster(), studioProjectHeaderPortalTarget)
        : null}

      <header
        data-top-shell
        data-fixed-ui
        className={`canvas-adaptive-header absolute left-0 top-0 z-[70] flex w-full px-4 ${studioChrome && studioProjectHeaderInAgent ? "justify-end" : "justify-between"} ${studioChrome ? "canvas-studio-header" : "items-start py-5"}`}
      >
        {!studioChrome || !studioProjectHeaderInAgent || !studioProjectHeaderPortalTarget
          ? renderProjectHeaderCluster()
          : null}

        {renderStudioHeaderActions()}
      </header>

      {canvasShareOverlay === "menu" ? <CanvasPublicationMenu popoverRef={canvasSharePopoverRef} publicationError={canvasPublicationError} publicationBusy={canvasPublicationBusy} canPublish={canvasCapabilities.fjtvPublish} canShare={canvasCapabilities.canvasShare} submitPublication={() => void submitCurrentCanvasToFjtv()} createShare={() => void createPublicCanvasShare()} publications={fjtvPublications} statusLabel={getCanvasPublicationStatusLabel} publicUrl={publicFjtvUrl} loading={canvasPublicationLoading} shares={getActiveCanvasShares(canvasShares)} copyShare={(share) => void navigator.clipboard?.writeText(publicCanvasShareUrl(share.slug)).then(() => setStatus("分享链接已复制"))} revokeShare={(share) => void revokePublicCanvasShare(share as typeof canvasShares[number])} /> : null}
      {canvasShareOverlay === "pointsPopover" ? <CanvasPointsPopover popoverRef={canvasSharePopoverRef} balanceLabel={accountBalanceLabel} error={canvasBalance.error} refresh={canvasBalance.refresh} navigate={navigateFromCanvasPanel} onClose={() => setCanvasShareOverlay(null)} /> : null}

      {canvasShareOverlay === "user" ? <CanvasAccountMenu popoverRef={canvasSharePopoverRef} accountProfile={accountProfile} balanceLabel={accountBalanceLabel} balanceError={canvasBalance.error} refreshBalance={canvasBalance.refresh} colorMode={canvasColorMode} navigate={navigateFromCanvasPanel} switchColorMode={switchCanvasColorMode} logout={handleCanvasLogout} onClose={() => setCanvasShareOverlay(null)} /> : null}
</>;
}
