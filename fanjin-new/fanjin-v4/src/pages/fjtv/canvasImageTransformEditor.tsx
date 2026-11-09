import React from "react";
import { Columns3, Expand, Rows3 } from "lucide-react";

export function renderImageTransformEditorExternal(deps: any, node: any): React.ReactNode {
  const { activeImageTransform, setActiveImageTransform, normalizeImageRotation, saveImageTransform } = deps;
  if (!node.imageTransformMode || !activeImageTransform || activeImageTransform.nodeId !== node.id) return null;
  return (
    <div data-fixed-ui data-node-toolbar className="absolute z-40 flex items-center gap-3 rounded-[18px] border border-[#3f4044] bg-[#232325] px-4 py-3 shadow-[0_22px_52px_rgba(0,0,0,0.42)]" style={{ left: node.x + node.width / 2, top: node.y - 58, transform: "translateX(-50%)" }} onMouseDown={(event) => event.stopPropagation()}>
      <span className="text-[15px] font-medium text-white">旋转与镜像</span>
      <button className="flex h-9 w-9 items-center justify-center rounded-[10px] text-white hover:bg-white/10" onClick={() => setActiveImageTransform((prev: any) => (prev ? { ...prev, rotation: normalizeImageRotation(prev.rotation + 90), angleInput: String(normalizeImageRotation(prev.rotation + 90)) } : prev))}><Expand className="h-4 w-4 rotate-45" /></button>
      <button className="flex h-9 w-9 items-center justify-center rounded-[10px] text-white hover:bg-white/10" onClick={() => setActiveImageTransform((prev: any) => (prev ? { ...prev, flipX: !prev.flipX } : prev))}><Columns3 className="h-4 w-4" /></button>
      <button className="flex h-9 w-9 items-center justify-center rounded-[10px] text-white hover:bg-white/10" onClick={() => setActiveImageTransform((prev: any) => (prev ? { ...prev, flipY: !prev.flipY } : prev))}><Rows3 className="h-4 w-4" /></button>
      <input className="h-9 w-[74px] rounded-[10px] border border-[#4b4d52] bg-transparent px-3 text-center text-white outline-none" value={activeImageTransform.angleInput} onChange={(event) => setActiveImageTransform((prev: any) => (prev ? { ...prev, angleInput: event.target.value, rotation: normalizeImageRotation(Number(event.target.value) || 0) } : prev))} />
      <button className="flex h-10 items-center justify-center rounded-[12px] bg-white px-4 text-[#161719]" onClick={() => saveImageTransform(node)}>保存</button>
    </div>
  );
}
