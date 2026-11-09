import type * as React from "react";

export function renderCanvasNodeGlyph(type: string, variant: "node" | "header" = "node", Music4: React.ComponentType<any>, Scissors: React.ComponentType<any>): React.ReactElement {
  const nodeColor = "text-[#555557]";
  const headerColor = "text-[#8d8d8f]";
  if (type === "video") return <svg viewBox="0 0 64 72" aria-hidden="true" className={variant === "header" ? `h-[20px] w-[20px] ${headerColor}` : `h-[76px] w-[76px] ${nodeColor}`}><path d="M18 12L52 36L18 60V12Z" fill="currentColor" /></svg>;
  if (type === "text") return variant === "header" ? <svg viewBox="0 0 24 24" aria-hidden="true" className={`h-[22px] w-[22px] ${headerColor}`}><rect x="4" y="3" width="16" height="18" rx="2" fill="currentColor" /><rect x="8" y="8" width="9" height="1.8" rx="0.9" fill="#242424" opacity="0.72" /><rect x="8" y="12" width="9" height="1.8" rx="0.9" fill="#242424" opacity="0.72" /><rect x="8" y="16" width="6" height="1.8" rx="0.9" fill="#242424" opacity="0.72" /></svg> : <svg viewBox="0 0 96 78" aria-hidden="true" className={`h-[78px] w-[96px] ${nodeColor}`}><rect x="18" y="17" width="60" height="7" rx="1" fill="currentColor" /><rect x="18" y="32" width="60" height="7" rx="1" fill="currentColor" /><rect x="18" y="47" width="60" height="7" rx="1" fill="currentColor" /><rect x="18" y="62" width="36" height="7" rx="1" fill="currentColor" /></svg>;
  if (type === "audio") return <Music4 className={variant === "header" ? `h-[20px] w-[20px] ${headerColor}` : `h-[72px] w-[72px] ${nodeColor}`} strokeWidth={1.8} />;
  if (type === "compose") return <Scissors className={variant === "header" ? `h-[20px] w-[20px] ${headerColor}` : `h-[72px] w-[72px] ${nodeColor}`} strokeWidth={1.8} />;
  return <svg viewBox="0 0 120 92" aria-hidden="true" className={variant === "header" ? `h-[22px] w-[28px] ${headerColor}` : `h-[92px] w-[128px] ${nodeColor}`}><path d="M22 72L49 34L72 72H22Z" fill="currentColor" /><path d="M58 72L82 44L106 72H58Z" fill="currentColor" /><circle cx="85" cy="24" r="9" fill="currentColor" /></svg>;
}
