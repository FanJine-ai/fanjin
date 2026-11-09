import type { RefObject } from "react";
import { ChevronDown } from "lucide-react";

export function CanvasPointsPopover({ popoverRef, balanceLabel, error, refresh, navigate, onClose }: {
  popoverRef: RefObject<HTMLDivElement | null>;
  balanceLabel: string;
  error?: string | null;
  refresh: () => void;
  navigate: (path: string) => void;
  onClose: () => void;
}) {
  return <div ref={popoverRef} id="canvas-share-popover" data-canvas-popover role="dialog" aria-label="GU 余额与账号入口" tabIndex={-1} onMouseLeave={onClose} className="absolute right-[34px] top-[112px] z-[143] w-[528px] rounded-[28px] border border-[#505050] bg-[#1b1b1b] p-5 text-white shadow-[0_28px_80px_rgba(0,0,0,0.64)]">
    <div data-canvas-surface className="flex items-center justify-between rounded-[18px] border border-[#505050] bg-[#282828] px-5 py-6">
      <div role={error ? "alert" : "status"} className="min-w-0 text-[26px] font-black" title={error || undefined}>GU 余额：{balanceLabel}{error ? <div data-canvas-danger className="mt-2 truncate text-[13px] font-medium text-[#f2a987]">{error}</div> : null}</div>
      {error ? <button type="button" onClick={refresh} className="ml-4 rounded-[10px] border border-white/20 px-3 py-2 text-[13px] font-semibold hover:bg-white/8">重试</button> : null}
      <button data-canvas-link type="button" onClick={() => navigate("/workspace/billing")} className="text-[20px] font-semibold text-[#74dbff]">账单与用量</button>
    </div>
    <div data-canvas-divider className="mt-5 border-t border-[#363636] pt-4">{[{ label: "账单与用量", path: "/workspace/billing" }, { label: "账号资料", path: "/settings/profile/basic" }].map(({ label, path }) => <button key={label} type="button" onClick={() => navigate(path)} className="flex h-[68px] w-full items-center justify-between rounded-[12px] px-3 text-[24px] font-black hover:bg-white/6"><span>{label}</span><ChevronDown data-canvas-muted className="-rotate-90 h-6 w-6 text-white/86" /></button>)}</div>
  </div>;
}
