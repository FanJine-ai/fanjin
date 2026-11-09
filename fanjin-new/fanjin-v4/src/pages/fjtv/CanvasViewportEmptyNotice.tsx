export function CanvasViewportEmptyNotice({ onReturn }: { onReturn: () => void }) {
  return <div data-fixed-ui className="canvas-adaptive-center absolute bottom-[92px] left-1/2 z-[80] -translate-x-1/2">
    <div data-canvas-callout className="flex items-center gap-4 rounded-[24px] border border-[#3f4044] bg-[#2b2b2d]/96 px-7 py-4 text-[16px] text-[#f0f1f4] shadow-[0_24px_58px_rgba(0,0,0,0.45)] backdrop-blur">
      <span>当前视窗没有节点，可点击按钮快速回到内容区域</span>
      <button type="button" className="rounded-full bg-white px-6 py-2 text-[16px] font-medium text-[#343434] transition hover:bg-[#f2f2f2]" onClick={(event) => { event.stopPropagation(); onReturn(); }}>回到节点</button>
    </div>
  </div>;
}
