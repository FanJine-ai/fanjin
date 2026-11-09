import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
export type VideoResolutionDelivery = "native" | "quality_enhancement";

export interface VideoResolutionDeliveryProofView {
  resolution: string;
  delivery: VideoResolutionDelivery;
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  bitrateBps: number;
  audioTrackCount: number;
  audioCodecs: string[];
  contentLengthBytes: number;
  downloadVerified: true;
  costMicros: number;
  currency: "GU";
}

export interface VideoResolutionDeliveryPresentation {
  resolutionLabel: string;
  label: "原生直出" | "履约超分";
  description: string;
  tone: "success" | "info";
  evidence: string[];
}

function resolutionLabel(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "2k" || normalized === "4k") return normalized.toUpperCase();
  return normalized === "1080p" ? "1080p" : normalized === "720p" ? "720p" : value;
}

function decimal(value: number, digits: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function proofEvidence(proof: VideoResolutionDeliveryProofView | null | undefined): string[] {
  if (!proof) return [];
  const audio = proof.audioTrackCount > 0
    ? `${proof.audioTrackCount} 条音轨${proof.audioCodecs.length ? `，${proof.audioCodecs.join(" / ").toUpperCase()}` : ""}`
    : "0 条音轨，原请求未要求音频";
  return [
    `${proof.width} × ${proof.height} 实测像素`,
    `${decimal(proof.bitrateBps / 1_000_000, 1)} Mbps`,
    audio,
    `${decimal(proof.contentLengthBytes / 1_048_576, 1)} MiB`,
    `${decimal(proof.durationMs / 1_000, 1)} 秒`,
    `${decimal(proof.costMicros / GU_MICROS_PER_GU, 3)} GU 实际成本`,
    proof.downloadVerified ? "下载与持久化校验通过" : "下载校验未通过",
  ];
}

/** Shared wording for Admin, Quick Create and Canvas resolution controls. */
export function getVideoResolutionDeliveryPresentation(input: {
  resolution: string;
  delivery: VideoResolutionDelivery;
  proof?: VideoResolutionDeliveryProofView | null;
}): VideoResolutionDeliveryPresentation {
  const native = input.delivery === "native";
  return {
    resolutionLabel: resolutionLabel(input.resolution),
    label: native ? "原生直出" : "履约超分",
    description: native
      ? "上游生成结果直接达到目标分辨率，不经超分履约。"
      : "先生成可靠源视频，再由已认证的超分流程交付目标分辨率。",
    tone: native ? "success" : "info",
    evidence: proofEvidence(input.proof),
  };
}
