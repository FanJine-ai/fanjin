import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import "./tokens.css";
import "./controls.css";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastInput {
  title: string;
  message?: string;
  tone?: ToastTone;
  duration?: number;
  action?: ReactNode;
}

interface ToastRecord extends ToastInput {
  id: string;
  tone: ToastTone;
  duration: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toneIcons: Record<ToastTone, ReactNode> = {
  info: <Info size={18} />,
  success: <CheckCircle2 size={18} />,
  warning: <TriangleAlert size={18} />,
  danger: <CircleAlert size={18} />,
};

function normalizeDuration(duration?: number) {
  return Math.min(5000, Math.max(3000, duration ?? 4000));
}

function ToastItem({ item, onDismiss }: { item: ToastRecord; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.duration, item.id, onDismiss]);

  return (
    <article className={`cuiToast cuiToast--${item.tone}`} role="status">
      <span className="cuiToast__icon" aria-hidden="true">{toneIcons[item.tone]}</span>
      <div className="cuiToast__content">
        <strong>{item.title}</strong>
        {item.message ? <p>{item.message}</p> : null}
        {item.action ? <div className="cuiToast__action">{item.action}</div> : null}
      </div>
      <button type="button" className="cuiToast__close" aria-label={`关闭通知：${item.title}`} onClick={() => onDismiss(item.id)}>
        <X size={17} />
      </button>
    </article>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const sequence = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearToasts = useCallback(() => setItems([]), []);

  const toast = useCallback((input: ToastInput) => {
    sequence.current += 1;
    const id = `console-toast-${Date.now()}-${sequence.current}`;
    const next: ToastRecord = {
      ...input,
      id,
      tone: input.tone ?? "info",
      duration: normalizeDuration(input.duration),
    };
    setItems((current) => [...current.slice(-3), next]);
    return id;
  }, []);

  const contextValue = useMemo(() => ({ toast, dismissToast, clearToasts }), [clearToasts, dismissToast, toast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {typeof document === "undefined" ? null : createPortal(
        <div
          className="cuiToastViewport"
          aria-live="polite"
          aria-atomic="false"
          aria-label="系统通知"
          data-console-overlay-keepalive="toast"
        >
          {items.map((item) => <ToastItem key={item.id} item={item} onDismiss={dismissToast} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast 必须在 ToastProvider 内使用");
  return value;
}
