import { seedanceReferenceRequirements } from "./referenceRequirements";
import "./ReferenceRequirementsHint.css";

export default function ReferenceRequirementsHint({ modelId, limits, mode, totalLimit }: {
  modelId: string;
  mode?: string;
  totalLimit?: number;
  limits: { image: number; video: number; file: number };
}) {
  const rule = seedanceReferenceRequirements(modelId);
  if (limits.image + limits.video + limits.file === 0) return null;
  const summary = [
    limits.image > 0 ? `图片最多 ${limits.image} 张` : null,
    limits.video > 0 ? `视频最多 ${Math.min(limits.video, rule?.videoMax ?? limits.video)} 段${rule ? `，合计 ≤${rule.durationMax} 秒` : ""}` : null,
    limits.file > 0 ? `音频最多 ${Math.min(limits.file, rule?.audioMax ?? limits.file)} 段${rule ? `，合计 ≤${rule.durationMax} 秒` : ""}` : null,
  ].filter(Boolean).join("；");
  return <div className="referenceRequirementsHint" aria-label="当前模型的参考素材要求">
    <span>{totalLimit != null && limits.image + limits.video + limits.file > totalLimit ? `合计最多 ${totalLimit} 个参考；` : ""}{summary}</span>
    {rule ? <details>
      <summary>查看格式要求</summary>
      <ul>
        {limits.image > 0 ? <li>单张图片小于 30 MB；宽高各 300–6000 像素，宽高比 0.4–2.5。</li> : null}
        {limits.video > 0 ? <li>视频：MP4 / MOV，H.264 / H.265 编码，单个 ≤200 MB，24–60 FPS；每段 {mode === "video_edit" && rule.audioOnly ? 4 : 2}–{rule.durationMax} 秒。宽高各 300–6000 像素，宽高比 0.4–2.5，总像素 407696–8295044。</li> : null}
        {limits.file > 0 ? <li>音频：WAV / MP3，单个 ≤15 MB，每段 2–{rule.durationMax} 秒。{mode === "video_extension" ? "延长视频仍需连接原片。" : rule.audioOnly ? "支持音频单独参考。" : "还需至少一张图片或一段视频。"}</li> : null}
      </ul>
    </details> : null}
  </div>;
}
