import { Hand, Mouse, X } from "lucide-react";

export type CanvasShortcutSection = {
  title: string;
  rows: Array<{
    label: string;
    keys?: string[];
    gesture?: "hand" | "mouse";
    suffix?: string;
  }>;
};

export function CanvasShortcutPanel({
  sections,
  onClose,
}: {
  sections: CanvasShortcutSection[];
  onClose: () => void;
}) {
  return (
    <div id="canvas-shortcut-panel" data-shortcut-panel className="canvas-adaptive-center canvas-shortcut-panel absolute bottom-[66px] left-1/2 z-[96] -translate-x-1/2 px-0 py-5">
      <button type="button" aria-label="关闭快捷键说明" className="absolute right-4 top-4 text-[#d5d5d7] transition hover:text-white" onClick={onClose}><X className="h-5 w-5" /></button>
      <div className="grid grid-cols-4">
        {sections.map((section) => (
          <div key={section.title} className="canvas-shortcut-section">
            <div className="canvas-shortcut-title">{section.title}</div>
            <div>
              {section.rows.map((row) => (
                <div key={row.label} className="canvas-shortcut-row">
                  <span>{row.label}</span>
                  <span className="canvas-shortcut-keys">
                    {row.keys?.map((key) => <span key={key} className="canvas-shortcut-key">{key}</span>)}
                    {row.gesture ? <span className="canvas-shortcut-gesture" aria-hidden="true"><span className="canvas-shortcut-gesture-mark">⌁</span>{row.gesture === "hand" ? <Hand /> : <Mouse />}</span> : null}
                    {row.suffix ? <span className="canvas-shortcut-suffix">{row.suffix}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
