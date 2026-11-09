import type * as React from "react";

export function renderModelCatalogStatus(message: string | null | undefined, state: string, setReloadToken: (updater: (value: number) => number) => void, LoaderCircle: React.ComponentType<any>): React.ReactNode {
  if (!message) return null;
  const loading = state === "loading";
  return <div data-node-model-catalog-status={state} className="flex min-h-32 flex-col items-center justify-center rounded-[14px] border border-[#414246] bg-[#252526] px-5 py-6 text-center">
    <div className="text-[13px] leading-5 text-[#b8bbc2]">{message}</div>
    {!loading ? <button type="button" className="mt-4 rounded-[9px] border border-[#505156] px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-[#343537]" onClick={() => setReloadToken((value) => value + 1)}>重新加载</button> :
      <LoaderCircle className="mt-4 h-4 w-4 animate-spin text-[#aeb2ba] motion-reduce:animate-none" aria-label="正在加载模型目录" />}
  </div>;
}
