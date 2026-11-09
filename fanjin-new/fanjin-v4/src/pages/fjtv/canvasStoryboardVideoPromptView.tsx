
export interface CanvasStoryboardVideoPromptViewDependencies {
  activeStoryboardVideoInputs: { prompts: string[]; names: string[]; errors: string[]; };
}

export function createCanvasStoryboardVideoPromptView({
  activeStoryboardVideoInputs,
}: CanvasStoryboardVideoPromptViewDependencies) {
function renderStoryboardVideoPrompt() {
    if (!activeStoryboardVideoInputs.names.length && !activeStoryboardVideoInputs.errors.length) return null;
    return <div data-storyboard-video-prompt className="mb-3 rounded-xl border border-[#52667d] bg-[#304256]/30 px-3 py-2 text-[12px] leading-relaxed text-[#c5d8ec]">
      {activeStoryboardVideoInputs.names.length ? <details>
        <summary className="cursor-pointer font-medium">已引用分镜：{activeStoryboardVideoInputs.names.join("、")} · 查看视频提示词</summary>
        <div className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap">{activeStoryboardVideoInputs.prompts.join("\n\n")}</div>
      </details> : null}
      {activeStoryboardVideoInputs.errors.map((message) => <div key={message} role="alert" className="text-[#f4bd84]">{message}</div>)}
    </div>;
  }
  return { renderStoryboardVideoPrompt };
}
