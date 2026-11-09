/**
 * Turn provider / task failures into copy a creator can act on.
 * Every message states (1) whose problem it is and (2) what to do next.
 */

export type CanvasErrorOwner = "user" | "platform" | "unknown";

export type FriendlyCanvasError = {
  /** Short title shown on the node chip. */
  title: string;
  /** Full sentence for the status bar. */
  message: string;
  owner: CanvasErrorOwner;
  /** Optional technical detail for tooltips / debug; not primary copy. */
  detail?: string;
};

function clean(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

function fieldFrom(text: string): string {
  const m =
    text.match(/parameter\s*`([^`]+)`/i)
    || text.match(/parameter\s*'([^']+)'/i)
    || text.match(/parameter\s*"?([A-Za-z0-9_\[\].]+)"?/i)
    || text.match(/\b(content\[\d+\])/i)
    || text.match(/\b([a-z][a-z0-9_]*(?:\[[0-9]+\])?)\b/i);
  return m ? m[1] : "";
}

function fieldLabel(field: string): string {
  const root = field.replace(/\[\d+\]$/, "");
  const index = field.match(/\[(\d+)\]/);
  const n = index ? Number(index[1]) + 1 : null;
  const names: Record<string, string> = {
    content: n ? `参考素材第 ${n} 项` : "参考素材",
    "content[0]": "提示词正文",
    image: n ? `图片第 ${n} 项` : "图片",
    images: n ? `图片第 ${n} 项` : "图片",
    video: n ? `视频第 ${n} 项` : "视频",
    videos: n ? `视频第 ${n} 项` : "视频",
    audio: n ? `音频第 ${n} 项` : "音频",
    audios: n ? `音频第 ${n} 项` : "音频",
    prompt: "提示词",
    text: "文本内容",
    model: "模型",
    duration: "时长",
    ratio: "画幅比例",
    resolution: "分辨率",
    seed: "随机种子",
    size: "尺寸",
  };
  if (field === "content[0]") return "提示词正文";
  return names[field] || names[root] || field;
}

/** Keep the provider sentence so the user sees the real reason, not a generic failure. */
function providerReason(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match =
    cleaned.match(/(?:because|:)\s*(.+)$/i)
    || cleaned.match(/(may contain sensitive information[^.]*\.?)/i)
    || cleaned.match(/(must be greater than or equal to[^.]*\.?)/i)
    || cleaned.match(/(is not valid[^.]*\.?)/i);
  const reason = (match ? match[1] : cleaned).trim();
  return reason.length > 140 ? `${reason.slice(0, 137)}…` : reason;
}

/**
 * Map a raw failure into user-facing copy.
 * `source` examples: "submit", "poll", "billing", "portrait".
 */
export function describeCanvasError(
  raw: unknown,
  source: "submit" | "poll" | "billing" | "portrait" | "upload" | "generic" = "generic",
): FriendlyCanvasError {
  const text = clean(raw);
  const lower = text.toLowerCase();
  const detail = text || undefined;

  if (/may contain real person|可能.*真人|疑似.*真人|PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED/i.test(text)) {
    return {
      owner: "user",
      title: "生成平台拒绝了人物素材",
      message: "生成平台认为输入图片或视频可能包含真人，已拒绝这次生成。若确属 AI 虚构角色，可在素材检查中确认虚拟来源并登记原素材；涉及真人或来源不明时，请更换素材或申请复核。不会自动重新提交。",
      detail,
    };
  }

  if (/上游内容审核未通过|\bCONTENT_REVIEW_REJECTED\b/.test(text)) {
    return {
      owner: "unknown",
      title: "上游内容审核未通过",
      message: "上游内容审核未通过，请检查提示词与参考素材是否符合内容要求；如认为是误判，请联系平台复核，勿原样重复提交。",
    };
  }

  if (/sensitive information|sensitive content|content.?policy|nsfw|safety|risk|审核未通过|违规|敏感|InputImageSensitive/i.test(text)) {
    const field = fieldFrom(text);
    const label = field ? fieldLabel(field) : "参考素材或提示词";
    return {
      owner: "user",
      title: "内容未通过安全检查",
      message: `${label}触发了平台安全检查：${providerReason(text)}；请调整该处措辞或更换素材后重试。多人图可改作构图参考，或拆成单人图后作为人物参考`,
      detail,
    };
  }

  // Upstream identity / portrait rules (e.g. single-person consistency).
  if (/single.?person|单人|一致性|identity|portrait.*(reject|block|fail)|人脸.*(拒绝|不合格|不合格)/i.test(text)) {
    return {
      owner: "user",
      title: "人物素材未满足上游要求",
      message: `上游要求人物参考满足单人一致性：${providerReason(text)}；请在素材检查里改为真人/虚拟分类，或拆成单人图、换用更清晰的单人脸参考`,
      detail,
    };
  }

  // --- User reference / input problems ---
  if (/pixel count|像素|分辨率过低|too small|minimum.*resolution|must be greater than or equal/i.test(text)) {
    const field = fieldFrom(text);
    const label = field ? fieldLabel(field) : "参考视频";
    const minMatch = text.match(/(?:greater than or equal to|≥|至少)\s*(\d{3,})/i);
    const minPx = minMatch ? Number(minMatch[1]) : null;
    const approx = minPx ? `约 ${Math.ceil(Math.sqrt(minPx * 16 / 9))}×${Math.ceil(Math.sqrt(minPx * 9 / 16))}` : "更高";
    return {
      owner: "user",
      title: "参考视频分辨率过低",
      message: minPx
        ? `${label}清晰度不够（需至少约 ${minPx.toLocaleString()} 像素，约 ${approx}）；请换更高清的视频或放大后重传`
        : `${label}清晰度不够；请换更高清的视频后重传`,
      detail,
    };
  }
  if (
    /content\[\d+\]/i.test(text)
    || /parameter .* is not valid/i.test(text)
    || /invalid parameter/i.test(text)
    || /missing parameter/i.test(text)
    || /badrequest/i.test(text)
    || /unsupported (image|video|audio|file|format|media)/i.test(text)
    || /image.*(too large|exceed|size)/i.test(text)
    || /video.*(too large|exceed|duration)/i.test(text)
    || /audio.*(too large|exceed|duration)/i.test(text)
    || /resolution.*not supported/i.test(text)
    || /aspect.?ratio/i.test(text) && /invalid|not supported/i.test(text)
  ) {
    const field = fieldFrom(text);
    const label = field ? fieldLabel(field) : "参考素材";
    if (/content\[\d+\]|parameter/i.test(text) || field) {
      return {
        owner: "user",
        title: "参考内容有问题",
        message: `${label}不符合要求：${providerReason(text)}；请修改该项后重试`,
        detail,
      };
    }
    if (/too large|exceed|size/i.test(text)) {
      return {
        owner: "user",
        title: "素材过大",
        message: `${label}文件太大，请压缩后重传，或换一张/段更小的素材`,
        detail,
      };
    }
    if (/duration/i.test(text)) {
      return {
        owner: "user",
        title: "时长不符合要求",
        message: `${label}时长超出模型限制，请剪短后重试`,
        detail,
      };
    }
    return {
      owner: "user",
      title: "生成参数不合法",
      message: `${label}或生成设置不被支持，请检查参考素材与模型参数后重试`,
      detail,
    };
  }

  if (/portrait|人脸|肖像|人像/i.test(text) && /fail|error|unavailable|不可用|失败/i.test(text)) {
    return {
      owner: "platform",
      title: "人物检查暂时失败",
      message: "人物素材检查服务暂时不可用，这不是内容问题；稍后重试即可，无需改图",
      detail,
    };
  }

  // --- Platform / service problems ---
  if (
    /internalerror|rtcAudit|timeout|timed ?out|503|502|504|500|unavailable|overloaded|quota.*exceed|rate ?limit|429/i.test(text)
    || /服务暂时|平台|上游|供应商/.test(text)
  ) {
    return {
      owner: "platform",
      title: "平台服务暂时异常",
      message: "生成服务暂时不可用，与你的素材无关；请稍后重试，已扣冻结额度会自动退还",
      detail,
    };
  }

  if (/unauthorized|403|forbidden|api.?key|token|登录|权限/i.test(text)) {
    return {
      owner: "user",
      title: "登录或权限问题",
      message: "当前账号无法提交生成，请重新登录或检查工作区权限",
      detail,
    };
  }

  if (/insufficient|余额|额度不足|balance|gu\b.*不足/i.test(text)) {
    return {
      owner: "user",
      title: "额度不足",
      message: "工作区可用额度不够本次生成，请充值或减少时长/分辨率后重试",
      detail,
    };
  }

  if (/cancel/i.test(text)) {
    return {
      owner: "user",
      title: "任务已取消",
      message: "本次生成已取消，可重新提交",
      detail,
    };
  }

  if (/pending_reconcile|账务待核|人工对账/i.test(text)) {
    return {
      owner: "platform",
      title: "正在同步结果",
      message: "暂未取得上游结果，请稍后查看原任务；费用记录可在账单中查询，请勿重复提交",
      detail,
    };
  }

  // --- Fallback: always surface the provider sentence ---
  if (text) {
    return {
      owner: /internalerror|rtaudit|timeout|5[0-9]{2}|unavailable/i.test(text) ? "platform" : "unknown",
      title: /internalerror|rtaudit|timeout|5[0-9]{2}|unavailable/i.test(text) ? "平台服务暂时异常" : "提交未成功",
      message: `原因：${providerReason(text)}`,
      detail,
    };
  }
  return {
    owner: "unknown",
    title: "提交未成功",
    message: "提交未成功，请稍后重试",
  };
}

export function formatFriendlyCanvasError(
  raw: unknown,
  source?: Parameters<typeof describeCanvasError>[1],
): string {
  return describeCanvasError(raw, source).message;
}
