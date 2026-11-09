import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "./controls";
import "./overlays.css";

export type OverlayCloseReason = "backdrop" | "cancel" | "close-button" | "escape" | "programmatic";
export type OverlayBackdrop = "dismissible" | "static" | "none";

export interface CloseGuardRenderProps {
  reason: OverlayCloseReason;
  discard: () => void;
  stay: () => void;
  pending: boolean;
}

export interface OverlayFooterRenderProps {
  requestClose: (reason?: OverlayCloseReason) => void;
  pending: boolean;
}

interface OverlayCommonProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode | ((props: OverlayFooterRenderProps) => ReactNode);
  onOpenChange: (open: boolean, reason?: OverlayCloseReason) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  labelledBy?: string;
  describedBy?: string;
  backdrop?: OverlayBackdrop;
  closeLabel?: string;
  showCloseButton?: boolean;
  loading?: boolean;
  dirty?: boolean;
  onBeforeClose?: (reason: OverlayCloseReason) => boolean | Promise<boolean>;
  renderCloseGuard?: (props: CloseGuardRenderProps) => ReactNode;
  closeGuardTitle?: ReactNode;
  closeGuardDescription?: ReactNode;
  role?: "dialog" | "alertdialog";
  className?: string;
  contentClassName?: string;
  portalContainer?: Element | DocumentFragment | null;
  "data-testid"?: string;
}

export interface DialogProps extends OverlayCommonProps {
  size?: "sm" | "md" | "lg" | "xl";
}

export interface DrawerProps extends OverlayCommonProps {
  side?: "left" | "right" | "bottom";
  size?: string;
}

let bodyLockCount = 0;
let originalBodyOverflow = "";
interface OverlayStackEntry {
  token: object;
  root: HTMLElement;
  backgroundElements: Set<HTMLElement>;
}

interface IsolationSnapshot {
  ariaHidden: string | null;
  inert: boolean;
}

const overlayStack: OverlayStackEntry[] = [];
const isolationSnapshots = new Map<HTMLElement, IsolationSnapshot>();
const OVERLAY_KEEPALIVE_ATTRIBUTE = "data-console-overlay-keepalive";

function isOverlayKeepalive(element: HTMLElement) {
  return element.hasAttribute(OVERLAY_KEEPALIVE_ATTRIBUTE);
}

function collectBackgroundElements(root: HTMLElement) {
  const elements = new Set<HTMLElement>();
  let branch: HTMLElement | null = root;

  while (branch && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (
        sibling !== branch
        && sibling instanceof HTMLElement
        && !isOverlayKeepalive(sibling)
      ) {
        elements.add(sibling);
      }
    }
    branch = parent;
  }

  return elements;
}

function restoreIsolation(element: HTMLElement, snapshot: IsolationSnapshot) {
  if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
  element.inert = snapshot.inert;
}

function syncOverlayIsolation() {
  const isolated = new Set<HTMLElement>();
  for (const entry of overlayStack) {
    for (const element of entry.backgroundElements) isolated.add(element);
  }

  let activeBranch: HTMLElement | null = overlayStack[overlayStack.length - 1]?.root ?? null;
  while (activeBranch) {
    isolated.delete(activeBranch);
    activeBranch = activeBranch.parentElement;
  }

  for (const [element, snapshot] of isolationSnapshots) {
    if (isolated.has(element)) continue;
    restoreIsolation(element, snapshot);
    isolationSnapshots.delete(element);
  }

  for (const element of isolated) {
    if (!isolationSnapshots.has(element)) {
      isolationSnapshots.set(element, {
        ariaHidden: element.getAttribute("aria-hidden"),
        inert: element.inert,
      });
    }
    element.setAttribute("aria-hidden", "true");
    element.inert = true;
  }
}

function registerOverlay(token: object, root: HTMLElement) {
  const previousIndex = overlayStack.findIndex((entry) => entry.token === token);
  if (previousIndex >= 0) overlayStack.splice(previousIndex, 1);
  overlayStack.push({ token, root, backgroundElements: collectBackgroundElements(root) });
  syncOverlayIsolation();

  return () => {
    const index = overlayStack.findIndex((entry) => entry.token === token);
    if (index >= 0) overlayStack.splice(index, 1);
    syncOverlayIsolation();
  };
}

function isTopOverlay(token: object) {
  return overlayStack[overlayStack.length - 1]?.token === token;
}

function lockBodyScroll() {
  if (typeof document === "undefined") return () => undefined;
  if (bodyLockCount === 0) {
    originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
  return () => {
    bodyLockCount = Math.max(0, bodyLockCount - 1);
    if (bodyLockCount === 0) document.body.style.overflow = originalBodyOverflow;
  };
}

function getFocusableElements(root: HTMLElement) {
  const candidates = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(candidates).filter((node) => {
    if (node.closest('[aria-hidden="true"], [inert]')) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

function joinClassNames(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

interface OverlayFrameProps extends OverlayCommonProps {
  kind: "dialog" | "drawer";
  panelClassName?: string;
  panelStyle?: CSSProperties;
  panelData?: Record<string, string>;
}

function OverlayFrame({
  kind,
  open,
  title,
  description,
  children,
  footer,
  onOpenChange,
  initialFocusRef,
  returnFocusRef,
  labelledBy,
  describedBy,
  backdrop = "dismissible",
  closeLabel = "关闭",
  showCloseButton = true,
  loading = false,
  dirty = false,
  onBeforeClose,
  renderCloseGuard,
  closeGuardTitle = "放弃未保存的更改？",
  closeGuardDescription = "关闭后，本次尚未保存的更改将丢失。此操作无法撤销。",
  role = "dialog",
  className,
  contentClassName,
  portalContainer,
  panelClassName,
  panelStyle,
  panelData,
  "data-testid": testId,
}: OverlayFrameProps) {
  const generatedTitleId = useId();
  const generatedDescriptionId = useId();
  const generatedGuardTitleId = useId();
  const generatedGuardDescriptionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const guardRef = useRef<HTMLDivElement>(null);
  const overlayTokenRef = useRef<object>({});
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const [guardReason, setGuardReason] = useState<OverlayCloseReason | null>(null);
  const [closePending, setClosePending] = useState(false);

  const titleId = labelledBy ?? generatedTitleId;
  const descriptionId = description ? (describedBy ?? generatedDescriptionId) : describedBy;

  const finishClose = useCallback(
    (reason: OverlayCloseReason) => {
      setGuardReason(null);
      onOpenChange(false, reason);
    },
    [onOpenChange],
  );

  const requestClose = useCallback(
    async (reason: OverlayCloseReason) => {
      if (loading || closePending) return;

      if (onBeforeClose) {
        setClosePending(true);
        try {
          if (await onBeforeClose(reason)) finishClose(reason);
        } finally {
          setClosePending(false);
        }
        return;
      }

      if (dirty) {
        setGuardReason(reason);
        return;
      }

      finishClose(reason);
    },
    [closePending, dirty, finishClose, loading, onBeforeClose],
  );

  useEffect(() => {
    if (!open) {
      setGuardReason(null);
      setClosePending(false);
      return;
    }

    restoreTargetRef.current = returnFocusRef?.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!rootRef.current) return;
    const unregister = registerOverlay(overlayTokenRef.current, rootRef.current);
    const unlock = lockBodyScroll();
    const animationFrame = window.requestAnimationFrame(() => {
      const preferredTarget = initialFocusRef?.current;
      const fallbackTarget = panelRef.current ? getFocusableElements(panelRef.current)[0] : null;
      (preferredTarget ?? fallbackTarget ?? panelRef.current)?.focus({ preventScroll: true });
    });

    return () => {
      const shouldRestoreFocus = isTopOverlay(overlayTokenRef.current);
      unregister();
      window.cancelAnimationFrame(animationFrame);
      unlock();
      const target = restoreTargetRef.current;
      window.requestAnimationFrame(() => {
        if (shouldRestoreFocus && target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [initialFocusRef, open, returnFocusRef]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlay(overlayTokenRef.current)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (guardReason) {
          setGuardReason(null);
          window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
        } else {
          void requestClose("escape");
        }
        return;
      }

      if (event.key !== "Tab" || !rootRef.current) return;
      const focusScope = guardReason ? guardRef.current : panelRef.current;
      if (!focusScope) return;
      const focusable = getFocusableElements(focusScope);
      if (focusable.length === 0) {
        event.preventDefault();
        focusScope.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusScope.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !focusScope.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [guardReason, open, requestClose]);

  useEffect(() => {
    if (!guardReason || !guardRef.current) return;
    const animationFrame = window.requestAnimationFrame(() => {
      if (!isTopOverlay(overlayTokenRef.current)) return;
      const target = getFocusableElements(guardRef.current!)[0] ?? guardRef.current;
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [guardReason]);

  const discard = useCallback(() => {
    if (!guardReason || closePending) return;
    finishClose(guardReason);
  }, [closePending, finishClose, guardReason]);

  const stay = useCallback(() => {
    setGuardReason(null);
    window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
  }, []);

  const guardContent = useMemo(() => {
    if (!guardReason) return null;
    if (renderCloseGuard) {
      return renderCloseGuard({ reason: guardReason, discard, stay, pending: closePending });
    }
    return (
      <>
        <div className="consoleOverlayGuardCopy">
          <h2 id={generatedGuardTitleId}>{closeGuardTitle}</h2>
          <p id={generatedGuardDescriptionId}>{closeGuardDescription}</p>
        </div>
        <div className="consoleOverlayGuardActions">
          <Button type="button" variant="secondary" onClick={stay} disabled={closePending}>
            继续编辑
          </Button>
          <Button type="button" variant="danger" onClick={discard} disabled={closePending}>
            放弃更改
          </Button>
        </div>
      </>
    );
  }, [closeGuardDescription, closeGuardTitle, closePending, discard, generatedGuardDescriptionId, generatedGuardTitleId, guardReason, renderCloseGuard, stay]);

  const footerContent = typeof footer === "function"
    ? footer({
        requestClose: (reason = "cancel") => void requestClose(reason),
        pending: loading || closePending,
      })
    : footer;

  if (!open || typeof document === "undefined") return null;

  const panel = (
    <div
      ref={rootRef}
      className={joinClassNames("consoleOverlayRoot", `consoleOverlayRoot-${kind}`, className)}
      data-backdrop={backdrop}
      data-testid={testId}
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (
          event.target === event.currentTarget
          && backdrop === "dismissible"
          && isTopOverlay(overlayTokenRef.current)
        ) {
          void requestClose("backdrop");
        }
      }}
    >
      {kind === "drawer" ? (
        <aside
          ref={panelRef}
          className={joinClassNames("consoleOverlayPanel", "consoleDrawerPanel", panelClassName)}
          style={panelStyle}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={loading || closePending || undefined}
          aria-hidden={guardReason ? "true" : undefined}
          inert={guardReason ? true : undefined}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          {...panelData}
        >
          <OverlayContents
            title={title}
            description={description}
            footer={footerContent}
            titleId={titleId}
            descriptionId={descriptionId}
            closeLabel={closeLabel}
            showCloseButton={showCloseButton}
            closeDisabled={loading || closePending}
            contentClassName={contentClassName}
            onClose={() => void requestClose("close-button")}
          >
            {children}
          </OverlayContents>
        </aside>
      ) : (
        <section
          ref={panelRef}
          className={joinClassNames("consoleOverlayPanel", "consoleDialogPanel", panelClassName)}
          style={panelStyle}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={loading || closePending || undefined}
          aria-hidden={guardReason ? "true" : undefined}
          inert={guardReason ? true : undefined}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          {...panelData}
        >
          <OverlayContents
            title={title}
            description={description}
            footer={footerContent}
            titleId={titleId}
            descriptionId={descriptionId}
            closeLabel={closeLabel}
            showCloseButton={showCloseButton}
            closeDisabled={loading || closePending}
            contentClassName={contentClassName}
            onClose={() => void requestClose("close-button")}
          >
            {children}
          </OverlayContents>
        </section>
      )}

      {guardReason && (
        <div className="consoleOverlayGuardBackdrop">
          <div
            ref={guardRef}
            className="consoleOverlayGuardPanel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={renderCloseGuard ? undefined : generatedGuardTitleId}
            aria-describedby={renderCloseGuard ? undefined : generatedGuardDescriptionId}
            aria-label={renderCloseGuard ? "未保存更改确认" : undefined}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {guardContent}
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(panel, portalContainer ?? document.body);
}

function OverlayContents({
  title,
  description,
  footer,
  titleId,
  descriptionId,
  closeLabel,
  showCloseButton,
  closeDisabled,
  contentClassName,
  onClose,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  titleId: string;
  descriptionId?: string;
  closeLabel: string;
  showCloseButton: boolean;
  closeDisabled: boolean;
  contentClassName?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <header className="consoleOverlayHeader">
        <div className="consoleOverlayHeading">
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        {showCloseButton && (
          <button type="button" className="consoleOverlayClose" aria-label={closeLabel} onClick={onClose} disabled={closeDisabled}>
            <X aria-hidden="true" size={20} strokeWidth={1.8} />
          </button>
        )}
      </header>
      {children !== null && children !== undefined && <div className={joinClassNames("consoleOverlayContent", contentClassName)}>{children}</div>}
      {footer && <footer className="consoleOverlayFooter">{footer}</footer>}
    </>
  );
}

export function Dialog({ size = "md", ...props }: DialogProps) {
  return <OverlayFrame kind="dialog" panelData={{ "data-size": size }} {...props} />;
}

export function Drawer({ side = "right", size, ...props }: DrawerProps) {
  const style = size ? ({ "--cui-overlay-size": size } as CSSProperties) : undefined;
  return <OverlayFrame kind="drawer" panelData={{ "data-side": side }} panelStyle={style} {...props} />;
}

export function Sheet(props: DrawerProps) {
  return <Drawer {...props} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: "default" | "danger";
  loading?: boolean;
  onConfirm: () => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  onConfirmError?: (error: unknown) => void;
  initialFocus?: "confirm" | "cancel";
  "data-testid"?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "default",
  loading = false,
  onConfirm,
  onCancel,
  onConfirmError,
  initialFocus = tone === "danger" ? "cancel" : "confirm",
  "data-testid": testId,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const busy = loading || pending;

  useEffect(() => {
    if (!open && !pendingRef.current) setPending(false);
  }, [open]);

  const handleConfirm = async () => {
    if (busy || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) onCancel();
    } catch (error) {
      onConfirmError?.(error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      role="alertdialog"
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
      initialFocusRef={initialFocus === "confirm" ? confirmRef : cancelRef}
      size="sm"
      loading={busy}
      data-testid={testId}
      footer={
        <div className="consoleOverlayActionRow">
          <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => void handleConfirm()}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {null}
    </Dialog>
  );
}
