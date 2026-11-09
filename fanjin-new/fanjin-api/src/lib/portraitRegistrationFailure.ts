/** Safe local copy for known media constraints. Never forward provider message bodies. */
export function portraitRegistrationFailureMessage(code: unknown): string | null {
  switch (code) {
    case "InvalidParameter.PixelCountTooSmall":
      return "参考素材总像素（宽 × 高）不足，无法登记。请使用更高分辨率的原素材，视频建议导出 720p 副本后重新上传；此错误与来源声明无关。";
    case "InvalidParameter.PixelCountTooLarge":
      return "参考素材总像素（宽 × 高）过高，无法登记。请降低分辨率后重新上传。";
    case "InvalidParameter.FpsTooLow":
      return "参考视频帧率过低，无法登记。请导出 24–60 fps 的视频后重新上传。";
    case "InvalidParameter.FpsTooHigh":
      return "参考视频帧率过高，无法登记。请导出 24–60 fps 的视频后重新上传。";
    default:
      return null;
  }
}
