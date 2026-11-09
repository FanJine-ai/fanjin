import { Circle, LogOut, Moon, ReceiptText, Sun, User } from "lucide-react";
import type { RefObject } from "react";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";
import { CANVAS_ACCOUNT_MENU_ITEMS } from "./canvasAccountMenuViewModel";

type AccountProfile = { avatarUrl?: string | null; initial: string; displayName: string; userId?: string | null };

export function CanvasAccountMenu({ popoverRef, accountProfile, balanceLabel, balanceError, refreshBalance, colorMode, navigate, switchColorMode, logout, onClose }: {
  popoverRef: RefObject<HTMLDivElement | null>;
  accountProfile: AccountProfile;
  balanceLabel: string;
  balanceError?: string | null;
  refreshBalance: () => void;
  colorMode: "light" | "dark";
  navigate: (path: string) => void;
  switchColorMode: (mode: "light" | "dark") => void;
  logout: () => void;
  onClose: () => void;
}) {
  return <div ref={popoverRef} id="canvas-share-popover" data-canvas-popover role="dialog" aria-label="当前账号菜单" tabIndex={-1} onMouseLeave={onClose} className="absolute right-[18px] top-[108px] z-[143] max-h-[calc(100vh-128px)] w-[700px] overflow-y-auto rounded-[28px] border border-[#575757] bg-[#1b1b1b] p-7 text-white shadow-[0_32px_90px_rgba(0,0,0,0.68)] [scrollbar-color:#9a9a9a_#272727]">
    <div data-canvas-surface className="rounded-[18px] bg-[#282828] p-7"><div className="flex items-center gap-5"><span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(180deg,#707dff,#3841ac)] text-[18px] font-bold shadow-[inset_0_1px_2px_rgba(255,255,255,.28)]">{accountProfile.avatarUrl ? <ReferencePreviewImage src={accountProfile.avatarUrl} alt="头像" className="h-full w-full object-cover" /> : accountProfile.initial}</span><div><div className="text-[24px] font-black">{accountProfile.displayName}</div><div data-canvas-muted className="mt-2 text-[17px] text-[#aeb6c0]">{accountProfile.userId ? `用户 ID ${accountProfile.userId}` : "当前账户"}</div></div></div></div>
    <div className="mt-7 rounded-[18px] border border-[#424242] px-7 py-6"><div className="flex items-center justify-between"><button type="button" onClick={() => navigate("/workspace/billing")} data-canvas-link className="text-[22px] font-black text-[#00d7ff]" title={balanceError || undefined}>GU 余额 {balanceLabel} 〉</button><button data-canvas-link type="button" onClick={() => navigate("/workspace/billing")} className="text-[20px] hover:text-[#00d7ff]">账单与用量</button></div><div data-canvas-muted role={balanceError ? "alert" : "status"} className="mt-5 text-[20px] text-[#c2cad5]">{balanceError ? <button data-canvas-danger type="button" onClick={refreshBalance} className="text-[#f2a987] hover:text-[#ffc2a3]">余额读取失败，点击重试</button> : <>通用 {balanceLabel}</>}</div></div>
    <div className="mt-8 space-y-1 pb-2">{CANVAS_ACCOUNT_MENU_ITEMS.map(({ label, key }) => { const Icon = key === "user" ? User : key === "subscription" ? ReceiptText : key === "mode" ? Circle : LogOut; if (key === "mode") return <div key={label} className="flex h-[66px] w-full items-center gap-5 rounded-[12px] px-3 text-[24px] font-black hover:bg-white/6"><Icon className="h-7 w-7 stroke-[2.2] text-white" /><span>{label}</span><span data-canvas-surface className="ml-auto inline-flex h-11 items-center rounded-full bg-[#343434] p-1"><button data-canvas-mode-option data-selected={colorMode === "light"} type="button" aria-label="浅色模式" onClick={() => switchColorMode("light")} className="flex h-9 w-9 items-center justify-center rounded-full"><Sun className="h-5 w-5" /></button><button data-canvas-mode-option data-selected={colorMode === "dark"} type="button" aria-label="深色模式" onClick={() => switchColorMode("dark")} className="flex h-9 w-9 items-center justify-center rounded-full"><Moon className="h-5 w-5" /></button></span></div>; const action = key === "user" ? () => navigate("/settings/profile/basic") : key === "subscription" ? () => navigate("/workspace/billing") : logout; return <button key={label} type="button" onClick={action} className="flex h-[66px] w-full items-center gap-5 rounded-[12px] px-3 text-left text-[24px] font-black hover:bg-white/6"><Icon className="h-7 w-7 stroke-[2.2] text-white" /><span>{label}</span></button>; })}</div>
  </div>;
}
