import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Moon, Sun, X } from "lucide-react";
import fanjinLogo from "../../assets/fanjin-logo-fj.svg";
import { useV4Theme } from "../../ui/useV4Theme";
import "./LoginPage.css";

export default function LoginDialogFrame({
  children,
  open,
  onClose,
  busy,
  focusPaused,
  tools,
}: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  focusPaused?: boolean;
  tools?: ReactNode;
}) {
  const theme = useV4Theme();
  const dialog = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy, focusPaused });
  latest.current = { onClose, busy, focusPaused };
  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() =>
      dialog.current?.querySelector<HTMLInputElement>("input")?.focus(),
    );
    function onKeyDown(event: KeyboardEvent) {
      if (latest.current.focusPaused || !dialog.current) return;
      if (event.key === "Escape" && !latest.current.busy) {
        event.preventDefault();
        latest.current.onClose();
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
        ),
      ).filter((element) => getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
      const first = elements[0],
        last = elements[elements.length - 1];
      if (!first) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div
      className={`loginOverlay ${theme.mode === "dark" ? "themeDark" : "themeLight"}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialog}
        className="loginDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        aria-busy={busy}
      >
        <div className="loginPoster">
          <img
            src="/assets/auth-creation-portal.png"
            alt="旅人走向沙漠中的光之门"
          />
          <span className="loginPosterBrand">FANJIN STUDIO</span>
          <div className="loginPosterCopy">
            <h2>让想象抵达画面</h2>
            <p>从一个想法，到一段好作品</p>
          </div>
        </div>
        <section className="loginContent">
          <header className="loginHeader">
            <div className="loginBrand">
              <img src={fanjinLogo} alt="" />
              <span>
                <strong>繁境</strong>
                <small>FANJIN</small>
              </span>
            </div>
            <div className="loginTools">
              {tools}
              <button
                type="button"
                aria-label={
                  theme.mode === "dark" ? "切换浅色主题" : "切换深色主题"
                }
                onClick={theme.toggle}
              >
                {theme.mode === "dark" ? <Sun size={19} /> : <Moon size={19} />}
              </button>
              <button
                type="button"
                aria-label="关闭登录"
                disabled={busy}
                onClick={onClose}
              >
                <X size={21} />
              </button>
            </div>
          </header>
          <div className="loginBody">{children}</div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
