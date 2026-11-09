import React from "react";

export function renderVideoOutputFormatPickerExternal(deps: any): React.ReactNode {
  const { activeNode, activeNodeModelOption, getCanvasCatalogVideoOutputFormats, getCanvasCatalogVideoDefaultOutputFormat, setNodePatch } = deps;
  const renderVideoOutputFormatPicker = () => {
    if (!activeNode || activeNode.type !== "video" || !activeNodeModelOption) return null;
    const formats = getCanvasCatalogVideoOutputFormats(activeNodeModelOption);
    if (formats.length < 2) return null;
    const selected = activeNode.videoOutputFormat || getCanvasCatalogVideoDefaultOutputFormat(activeNodeModelOption);
    return <>
      <div className="mb-2 mt-4 text-[13px] text-[#bbbcc0]">输出格式</div>
      <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="画布视频输出格式">
        {formats.map((format: any) => <button key={format} type="button" data-node-video-output-format={format}
          aria-pressed={selected === format}
          className={`h-9 rounded-[10px] border text-[13px] transition ${selected === format ? "border-[#ededee] text-white" : "border-[#56575a] text-[#8f939a] hover:border-[#6a6b70] hover:text-[#d8dade]"}`}
          onClick={() => setNodePatch(activeNode.id, { videoOutputFormat: format })}>{format.toUpperCase()}</button>)}
      </div>
    </>;
  };
  return renderVideoOutputFormatPicker();
}
