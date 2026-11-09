import type { AgentRuntimeStep } from "./types";

/** Only render persisted tool receipts, never image URLs invented in chat text. */
export function AgentGenerationResults({ steps }: { steps: AgentRuntimeStep[] }) {
  const assets = new Map<number, { assetVersionId: number; url: string }>();
  for (const step of steps) {
    const receipt = step.generationReceipt;
    if (step.status !== "succeeded" || receipt?.generationType !== "image" || receipt.status !== "succeeded") continue;
    for (const asset of receipt.assets) {
      if (/^https?:\/\//i.test(asset.url) || /^\/(?!\/)/.test(asset.url)) {
        assets.set(asset.assetVersionId, asset);
      }
    }
  }
  if (!assets.size) return null;
  return (
    <section className="generateAgentResults" aria-label="本轮生成图片">
      {[...assets.values()].map((asset, index) => (
        <a key={asset.assetVersionId} href={asset.url} target="_blank" rel="noopener noreferrer">
          <img src={asset.url} alt={`生成图片 ${index + 1}`} />
          <span>查看原图 · 已保存到资产</span>
        </a>
      ))}
    </section>
  );
}
