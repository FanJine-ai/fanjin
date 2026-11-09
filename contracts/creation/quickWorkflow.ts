type QuickCreateRatio = `${number}:${number}` | "adaptive";

export type QuickWorkflowPace = "slow" | "balanced" | "fast";
export type QuickWorkflowOriginalAudio = "keep" | "duck" | "mute";
export type QuickWorkflowSensitiveCategory = "none" | "cosmetics" | "health" | "finance" | "food";

export type QuickWorkflowBrief = {
  theme: string;
  sourceScript: string;
  productName: string;
  sellingPoints: string[];
  audience: string;
  channel: string;
  targetDuration: number;
  ratio: QuickCreateRatio;
  pace: QuickWorkflowPace;
  originalAudio: QuickWorkflowOriginalAudio;
  tone: string;
  priceClaim: string;
  efficacyClaims: string[];
  factSource: string;
  sensitiveCategory: QuickWorkflowSensitiveCategory;
  complianceNote: string;
  deliveryRatios: QuickCreateRatio[];
  deliveryDurations: number[];
  deliveryTones: string[];
  deliveryAudiences: string[];
};

export type CommerceValidationIssue = {
  code: "price_source_required" | "efficacy_source_required" | "sensitive_category_note_required";
  field: "priceClaim" | "efficacyClaims" | "complianceNote";
  message: string;
  blocking: true;
};

export type AutoEditTimelineItem = {
  videoId: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
};

export type AutoEditSourceClip = AutoEditTimelineItem & {
  title?: string;
  duration: number;
};

export type AutoEditSourcePurpose = "hook" | "story" | "proof" | "cta";

export type AutoEditSourceSelection = {
  videoId: number;
  included: boolean;
  purpose: AutoEditSourcePurpose;
  order: number;
};

export type AutoEditPreferences = {
  targetDuration: number;
  pace: QuickWorkflowPace;
  originalAudio: QuickWorkflowOriginalAudio;
  subtitles: boolean;
  soundtrackAssetVersionId: number | null;
  sourceSelections?: AutoEditSourceSelection[];
};

export type ExplainableAutoEdit = {
  timeline: AutoEditTimelineItem[];
  duration: number;
  explanations: string[];
  subtitleCues: AutoEditSubtitleCue[];
  beatMarkers: AutoEditBeatMarker[];
};

export type AutoEditSubtitleCue = {
  id: string;
  videoId: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type AutoEditBeatMarker = {
  id: string;
  timeSeconds: number;
  kind: "cut" | "beat";
};

export type CommerceDeliveryVariant = {
  id: string;
  label: string;
  ratio: QuickCreateRatio;
  duration: number;
  tone: string;
  audience: string;
};

export type CommerceVariantBatchStatus = "ready" | "editing" | "completed" | "failed";

export type CommerceVariantBatchItem = CommerceDeliveryVariant & {
  status: CommerceVariantBatchStatus;
  updatedAt: number;
  error?: string;
  taskIds?: string[];
  resultUrls?: string[];
  pendingSubmissions?: Array<{
    key: string;
    fingerprint: string;
    operationKey: string;
    knownTaskIds: string[];
  }>;
};

export type CommerceVariantBatch = {
  version: 1;
  createdAt: number;
  updatedAt: number;
  activeItemId?: string;
  items: CommerceVariantBatchItem[];
};

export type CommerceTaskEvidence = {
  videoId?: number;
  relayTaskId?: string;
  requestId?: string;
  status: string;
  url?: string;
  errorReason?: string;
  submissionKey?: string;
  operationKey?: string;
  knownTaskIds?: string[];
  fingerprint?: string;
};

export type EditRevision = {
  timeline: AutoEditTimelineItem[];
  savedAt: number;
};

export type EditRevisionBundle = {
  source: EditRevision;
  automatic: EditRevision;
  manual: EditRevision;
};

const paceLabels: Record<QuickWorkflowPace, string> = {
  slow: "舒缓节奏",
  balanced: "均衡节奏",
  fast: "快节奏",
};

const originalAudioLabels: Record<QuickWorkflowOriginalAudio, string> = {
  keep: "完整保留",
  duck: "保留并在配乐下自动压低",
  mute: "静音",
};

const sourcePurposeLabels: Record<AutoEditSourcePurpose, string> = {
  hook: "开场钩子",
  story: "叙事推进",
  proof: "卖点证据",
  cta: "行动收尾",
};

export function reconcileAutoEditSourceSelections(
  clips: Array<Pick<AutoEditSourceClip, "videoId">>,
  selections: AutoEditSourceSelection[] = [],
): AutoEditSourceSelection[] {
  const clipIds = new Set(clips.map((clip) => clip.videoId));
  const validPurposes: AutoEditSourcePurpose[] = ["hook", "story", "proof", "cta"];
  const priorById = new Map(selections
    .filter((selection) => clipIds.has(selection.videoId))
    .map((selection) => [selection.videoId, selection]));
  const orderedIds = [
    ...selections.filter((selection) => clipIds.has(selection.videoId)).sort((left, right) => left.order - right.order).map((selection) => selection.videoId),
    ...clips.map((clip) => clip.videoId).filter((videoId) => !priorById.has(videoId)),
  ];
  return [...new Set(orderedIds)].map((videoId, order) => {
    const prior = priorById.get(videoId);
    const sourceIndex = clips.findIndex((clip) => clip.videoId === videoId);
    const fallbackPurpose: AutoEditSourcePurpose = sourceIndex === 0
      ? "hook"
      : sourceIndex === clips.length - 1
        ? "cta"
        : "story";
    return {
      videoId,
      included: prior?.included ?? true,
      purpose: validPurposes.includes(prior?.purpose as AutoEditSourcePurpose) ? prior!.purpose : fallbackPurpose,
      order,
    };
  });
}

export function defaultQuickWorkflowBrief(): QuickWorkflowBrief {
  return {
    theme: "",
    sourceScript: "",
    productName: "",
    sellingPoints: [],
    audience: "",
    channel: "",
    targetDuration: 30,
    ratio: "16:9",
    pace: "balanced",
    originalAudio: "duck",
    tone: "",
    priceClaim: "",
    efficacyClaims: [],
    factSource: "",
    sensitiveCategory: "none",
    complianceNote: "",
    deliveryRatios: ["16:9"],
    deliveryDurations: [30],
    deliveryTones: [],
    deliveryAudiences: [],
  };
}

export function normalizeQuickWorkflowBrief(value: unknown): QuickWorkflowBrief {
  const fallback = defaultQuickWorkflowBrief();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const source = value as Partial<Record<keyof QuickWorkflowBrief, unknown>>;
  const strings = (items: unknown) => Array.isArray(items)
    ? items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 20)
    : [];
  const ratios = (items: unknown) => Array.isArray(items)
    ? [...new Set(items.filter((item): item is QuickCreateRatio => typeof item === "string" && /^\d+:\d+$/.test(item)))].slice(0, 6)
    : [];
  const durations = (items: unknown) => Array.isArray(items)
    ? [...new Set(items.map(Number).filter((item) => Number.isFinite(item)).map((item) => Math.min(300, Math.max(5, Math.round(item)))))].slice(0, 6)
    : [];
  const stringValue = (key: keyof QuickWorkflowBrief) => typeof source[key] === "string"
    ? String(source[key]).trim()
    : String(fallback[key] ?? "");
  const duration = Number(source.targetDuration);
  const ratio = typeof source.ratio === "string" && /^\d+:\d+$/.test(source.ratio)
    ? source.ratio as QuickCreateRatio
    : fallback.ratio;
  const pace = source.pace === "slow" || source.pace === "fast" || source.pace === "balanced"
    ? source.pace
    : fallback.pace;
  const originalAudio = source.originalAudio === "keep" || source.originalAudio === "duck" || source.originalAudio === "mute"
    ? source.originalAudio
    : fallback.originalAudio;
  const sensitiveCategory = source.sensitiveCategory === "cosmetics"
    || source.sensitiveCategory === "health"
    || source.sensitiveCategory === "finance"
    || source.sensitiveCategory === "food"
    || source.sensitiveCategory === "none"
    ? source.sensitiveCategory
    : fallback.sensitiveCategory;
  return {
    theme: stringValue("theme"),
    sourceScript: stringValue("sourceScript"),
    productName: stringValue("productName"),
    sellingPoints: strings(source.sellingPoints),
    audience: stringValue("audience"),
    channel: stringValue("channel"),
    targetDuration: Number.isFinite(duration) ? Math.min(300, Math.max(5, Math.round(duration))) : fallback.targetDuration,
    ratio,
    pace,
    originalAudio,
    tone: stringValue("tone"),
    priceClaim: stringValue("priceClaim"),
    efficacyClaims: strings(source.efficacyClaims),
    factSource: stringValue("factSource"),
    sensitiveCategory,
    complianceNote: stringValue("complianceNote"),
    deliveryRatios: ratios(source.deliveryRatios).length ? ratios(source.deliveryRatios) : [ratio],
    deliveryDurations: durations(source.deliveryDurations).length ? durations(source.deliveryDurations) : [Number.isFinite(duration) ? Math.min(300, Math.max(5, Math.round(duration))) : fallback.targetDuration],
    deliveryTones: strings(source.deliveryTones).slice(0, 6),
    deliveryAudiences: strings(source.deliveryAudiences).slice(0, 6),
  };
}

export function validateCommerceBrief(brief: QuickWorkflowBrief): CommerceValidationIssue[] {
  const issues: CommerceValidationIssue[] = [];
  if (brief.priceClaim.trim() && !brief.factSource.trim()) {
    issues.push({
      code: "price_source_required",
      field: "priceClaim",
      message: "价格信息需要填写可核对的商品页、价目表或活动规则来源。",
      blocking: true,
    });
  }
  if (brief.efficacyClaims.some((claim) => claim.trim()) && !brief.factSource.trim()) {
    issues.push({
      code: "efficacy_source_required",
      field: "efficacyClaims",
      message: "功效表述需要填写检测报告、批准文件或商品事实来源。",
      blocking: true,
    });
  }
  if (brief.sensitiveCategory !== "none" && !brief.complianceNote.trim()) {
    issues.push({
      code: "sensitive_category_note_required",
      field: "complianceNote",
      message: "敏感品类需要填写审核限制、禁用表述或人工复核说明。",
      blocking: true,
    });
  }
  return issues;
}

export function buildQuickWorkflowBriefText(input: QuickWorkflowBrief): string {
  const brief = normalizeQuickWorkflowBrief(input);
  return [
    brief.theme ? `主题：${brief.theme}` : "",
    brief.sourceScript ? `剧本/创意：${brief.sourceScript}` : "",
    brief.productName ? `商品：${brief.productName}` : "",
    brief.sellingPoints.length ? `真实卖点：${brief.sellingPoints.join("；")}` : "",
    brief.audience ? `目标人群：${brief.audience}` : "",
    brief.channel ? `投放渠道：${brief.channel}` : "",
    brief.tone ? `语气：${brief.tone}` : "",
    `交付规格：${brief.targetDuration} 秒 · ${brief.ratio} · ${paceLabels[brief.pace]}`,
    `原声策略：${originalAudioLabels[brief.originalAudio]}`,
    brief.priceClaim ? `价格表述：${brief.priceClaim}` : "",
    brief.efficacyClaims.length ? `功效表述：${brief.efficacyClaims.join("；")}` : "",
    brief.factSource ? `事实来源：${brief.factSource}` : "",
    brief.complianceNote ? `合规说明：${brief.complianceNote}` : "",
  ].filter(Boolean).join("\n");
}

function cloneTimeline(timeline: AutoEditTimelineItem[]): AutoEditTimelineItem[] {
  return timeline.map((item) => ({
    videoId: item.videoId,
    trimStart: Number(item.trimStart.toFixed(3)),
    trimEnd: Number(item.trimEnd.toFixed(3)),
    volume: Number(Math.min(2, Math.max(0, item.volume)).toFixed(3)),
  }));
}

export function buildExplainableAutoEdit(
  clips: AutoEditSourceClip[],
  preferences: AutoEditPreferences,
): ExplainableAutoEdit {
  const selections = reconcileAutoEditSourceSelections(clips, preferences.sourceSelections);
  const clipsById = new Map(clips.map((clip) => [clip.videoId, clip]));
  const selectedClips = selections
    .filter((selection) => selection.included)
    .map((selection) => clipsById.get(selection.videoId))
    .filter((clip): clip is AutoEditSourceClip => Boolean(clip));
  const targetDuration = Math.max(1, Number(preferences.targetDuration) || 1);
  const timeline: AutoEditTimelineItem[] = [];
  let remaining = targetDuration;
  const availableClips = selectedClips.flatMap((clip) => {
    const availableStart = Math.max(0, Number(clip.trimStart) || 0);
    const sourceEnd = Math.min(Number(clip.duration) || 0, Number(clip.trimEnd) || Number(clip.duration) || 0);
    const availableDuration = Math.max(0, sourceEnd - availableStart);
    return availableDuration ? [{ clip, availableStart, availableDuration }] : [];
  });
  const preferredCount = preferences.pace === "fast"
    ? availableClips.length
    : preferences.pace === "slow"
      ? 1
      : Math.max(1, Math.ceil(availableClips.length * 2 / 3));
  let selectedCount = Math.min(preferredCount, availableClips.length);
  while (
    selectedCount < availableClips.length
    && availableClips.slice(0, selectedCount).reduce((total, item) => total + item.availableDuration, 0) < targetDuration
  ) selectedCount += 1;
  const pacedClips = availableClips.slice(0, selectedCount);
  let trimmedTitle = "";
  let trimmedDuration = 0;
  for (let index = 0; index < pacedClips.length; index += 1) {
    if (remaining <= 0.0001) break;
    const { clip, availableStart, availableDuration } = pacedClips[index];
    const remainingSlots = pacedClips.length - index;
    const evenShare = remaining / remainingSlots;
    const laterCapacity = pacedClips.slice(index + 1).reduce((total, item) => total + item.availableDuration, 0);
    const requiredNow = Math.max(0, remaining - laterCapacity);
    const usedDuration = Math.min(availableDuration, remaining, Math.max(requiredNow, preferences.pace === "slow" ? remaining : evenShare));
    timeline.push({
      videoId: clip.videoId,
      trimStart: availableStart,
      trimEnd: Number((availableStart + usedDuration).toFixed(3)),
      volume: preferences.originalAudio === "mute" ? 0 : preferences.originalAudio === "duck" ? 0.65 : clip.volume,
    });
    if (usedDuration < availableDuration) {
      trimmedTitle = clip.title || `镜头 ${timeline.length}`;
      trimmedDuration = usedDuration;
    }
    remaining -= usedDuration;
  }
  const duration = Number(timeline.reduce((total, item) => total + item.trimEnd - item.trimStart, 0).toFixed(3));
  let cursor = 0;
  const subtitleCues: AutoEditSubtitleCue[] = preferences.subtitles
    ? timeline.map((item, index) => {
        const clip = clips.find((candidate) => candidate.videoId === item.videoId);
        const startSeconds = Number(cursor.toFixed(3));
        cursor += item.trimEnd - item.trimStart;
        return {
          id: `subtitle-${item.videoId}-${index}`,
          videoId: item.videoId,
          startSeconds,
          endSeconds: Number(cursor.toFixed(3)),
          text: clip?.title?.trim() || `镜头 ${index + 1}`,
        };
      })
    : [];
  const cutTimes: number[] = [];
  cursor = 0;
  timeline.forEach((item) => {
    cutTimes.push(Number(cursor.toFixed(3)));
    cursor += item.trimEnd - item.trimStart;
  });
  const interval = preferences.pace === "fast" ? 1 : preferences.pace === "slow" ? 4 : 2;
  const markerTimes = new Set<number>(cutTimes);
  for (let time = 0; time <= duration + 0.0001; time += interval) {
    markerTimes.add(Number(Math.min(duration, time).toFixed(3)));
  }
  const beatMarkers: AutoEditBeatMarker[] = [...markerTimes]
    .filter((time) => time >= 0 && time <= duration)
    .sort((left, right) => left - right)
    .map((time, index) => ({
      id: `beat-${index}`,
      timeSeconds: time,
      kind: cutTimes.some((cutTime) => Math.abs(cutTime - time) < 0.0001) ? "cut" : "beat",
    }));
  const explanations = [
    `已选 ${selectedClips.length}/${clips.length} 个素材，按指定顺序使用 ${timeline.length} 个镜头；目标 ${targetDuration} 秒，当前 ${duration} 秒。`,
    selections.filter((selection) => selection.included).length
      ? `素材用途：${selections.filter((selection) => selection.included).map((selection) => sourcePurposeLabels[selection.purpose]).join("、")}。`
      : "尚未选择可用于自动初剪的素材。",
    trimmedTitle ? `${paceLabels[preferences.pace]}按 ${timeline.length} 个实际镜头切点裁切；最后使用 ${trimmedDuration.toFixed(1)} 秒（${trimmedTitle}）。` : `${paceLabels[preferences.pace]}按 ${timeline.length} 个实际镜头切点组织。`,
    `节奏采用${paceLabels[preferences.pace]}；原声${originalAudioLabels[preferences.originalAudio]}。`,
    preferences.subtitles ? "字幕轨道已列入自动方案，后续可逐镜头修改。" : "自动方案不创建字幕轨道。",
    preferences.soundtrackAssetVersionId ? `使用配乐资产版本 #${preferences.soundtrackAssetVersionId}。` : "未绑定配乐资产。",
  ];
  return { timeline, duration, explanations, subtitleCues, beatMarkers };
}

export function buildCommerceVariants(
  input: QuickWorkflowBrief,
  maxVariants = 12,
): CommerceDeliveryVariant[] {
  const brief = normalizeQuickWorkflowBrief(input);
  const ratios = [...new Set(brief.deliveryRatios.length ? brief.deliveryRatios : [brief.ratio])];
  const durations = [...new Set(brief.deliveryDurations.length ? brief.deliveryDurations : [brief.targetDuration])];
  const tones = [...new Set(brief.deliveryTones.length ? brief.deliveryTones : [brief.tone])];
  const audiences = [...new Set(brief.deliveryAudiences.length ? brief.deliveryAudiences : [brief.audience])];
  const limit = Math.min(24, Math.max(1, Math.round(maxVariants) || 12));
  const variants: CommerceDeliveryVariant[] = [];
  for (const ratio of ratios) {
    for (const duration of durations) {
      for (const tone of tones) {
        for (const audience of audiences) {
          const id = [ratio, duration, tone || "default", audience || "all"]
            .join("|")
            .replace(/\s+/g, "-");
          variants.push({
            id,
            ratio,
            duration,
            tone,
            audience,
            label: [brief.productName || "交付版本", `${duration} 秒`, ratio, tone, audience].filter(Boolean).join(" · "),
          });
          if (variants.length >= limit) return variants;
        }
      }
    }
  }
  return variants;
}

export function createCommerceVariantBatch(
  input: QuickWorkflowBrief,
  previous: CommerceVariantBatch | null = null,
  now = Date.now(),
  maxVariants = 12,
): CommerceVariantBatch {
  const variants = buildCommerceVariants(input, maxVariants);
  const priorById = new Map(previous?.items.map((item) => [item.id, item]) ?? []);
  return {
    version: 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    items: variants.map((variant) => {
      const prior = priorById.get(variant.id);
      return prior
        ? {
            ...variant,
            status: prior.status,
            updatedAt: prior.updatedAt,
            ...(prior.error ? { error: prior.error } : {}),
            ...(prior.taskIds?.length ? { taskIds: [...prior.taskIds] } : {}),
            ...(prior.resultUrls?.length ? { resultUrls: [...prior.resultUrls] } : {}),
            ...(prior.pendingSubmissions?.length ? {
              pendingSubmissions: prior.pendingSubmissions.map((pending) => ({
                ...pending,
                knownTaskIds: [...pending.knownTaskIds],
              })),
            } : {}),
          }
        : { ...variant, status: "ready", updatedAt: now };
    }),
    ...(previous?.activeItemId && variants.some((variant) => variant.id === previous.activeItemId)
      ? { activeItemId: previous.activeItemId }
      : {}),
  };
}

export function updateCommerceVariantBatchItem(
  batch: CommerceVariantBatch,
  itemId: string,
  status: CommerceVariantBatchStatus,
  now = Date.now(),
  error = "",
): CommerceVariantBatch {
  if (!batch.items.some((item) => item.id === itemId)) return batch;
  return {
    ...batch,
    updatedAt: now,
    ...(status === "editing" ? { activeItemId: itemId } : batch.activeItemId === itemId ? { activeItemId: undefined } : {}),
    items: batch.items.map((item) => item.id === itemId
      ? {
          ...item,
          status,
          updatedAt: now,
          ...(status === "failed" && error.trim() ? { error: error.trim().slice(0, 500) } : { error: undefined }),
        }
      : item),
  };
}

function commerceTaskId(task: CommerceTaskEvidence) {
  return String(task.relayTaskId || task.requestId || (Number.isSafeInteger(Number(task.videoId)) ? `video-${task.videoId}` : "")).trim();
}

export function linkCommerceVariantBatchTasks(
  batch: CommerceVariantBatch,
  itemId: string,
  tasks: CommerceTaskEvidence[],
  now = Date.now(),
): CommerceVariantBatch {
  const target = batch.items.find((item) => item.id === itemId);
  const evidence = tasks
    .map((task) => ({ task, id: commerceTaskId(task), submissionKey: String(task.submissionKey || "").trim() }))
    .filter((entry) => entry.id || entry.submissionKey);
  if (!target || !evidence.length) return batch;
  const failed = evidence.filter(({ task }) => task.status === "failed" || task.status === "cancelled");
  const resolvedSubmissionKeys = new Set(evidence
    .filter(({ task }) => task.status === "succeeded" || task.status === "failed" || task.status === "cancelled")
    .map((entry) => entry.submissionKey)
    .filter(Boolean));
  const pendingByKey = new Map((target.pendingSubmissions ?? [])
    .filter((pending) => !resolvedSubmissionKeys.has(pending.key))
    .map((pending) => [pending.key, pending]));
  evidence
    .filter(({ task }) => task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled")
    .forEach(({ task, submissionKey }) => {
      if (!submissionKey) return;
      pendingByKey.set(submissionKey, {
        key: submissionKey,
        fingerprint: String(task.fingerprint || "").trim(),
        operationKey: String(task.operationKey || "").trim(),
        knownTaskIds: [...new Set((task.knownTaskIds ?? []).map(String).map((id) => id.trim()).filter(Boolean))],
      });
    });
  const pendingSubmissions = [...pendingByKey.values()];
  const completed = failed.length === 0
    && pendingSubmissions.length === 0
    && evidence.every(({ task }) => task.status === "succeeded");
  const status: CommerceVariantBatchStatus = failed.length ? "failed" : completed ? "completed" : "editing";
  const taskIds = [...new Set([...(target.taskIds ?? []), ...evidence.map((entry) => entry.id).filter(Boolean)])];
  const resultUrls = [...new Set([...(target.resultUrls ?? []), ...evidence.map(({ task }) => String(task.url || "").trim()).filter(Boolean)])];
  const error = failed.map(({ task }) => String(task.errorReason || "任务执行失败").trim()).filter(Boolean).join("；").slice(0, 500);
  const sameEvidence = target.status === status
    && JSON.stringify(target.taskIds ?? []) === JSON.stringify(taskIds)
    && JSON.stringify(target.resultUrls ?? []) === JSON.stringify(resultUrls)
    && JSON.stringify(target.pendingSubmissions ?? []) === JSON.stringify(pendingSubmissions)
    && String(target.error || "") === error;
  if (sameEvidence) return batch;
  return {
    ...batch,
    updatedAt: now,
    ...(status === "completed" || status === "failed"
      ? batch.activeItemId === itemId ? { activeItemId: undefined } : {}
      : { activeItemId: itemId }),
    items: batch.items.map((item) => item.id === itemId ? {
      ...item,
      status,
      updatedAt: now,
      taskIds,
      ...(resultUrls.length ? { resultUrls } : { resultUrls: undefined }),
      ...(pendingSubmissions.length ? { pendingSubmissions } : { pendingSubmissions: undefined }),
      ...(error ? { error } : { error: undefined }),
    } : item),
  };
}

export function reconcileCommerceVariantBatchTasks(
  batch: CommerceVariantBatch,
  tasks: CommerceTaskEvidence[],
  now = Date.now(),
): CommerceVariantBatch {
  let next = batch;
  for (const item of batch.items) {
    if (!item.taskIds?.length && !item.pendingSubmissions?.length) continue;
    if ((item.status === "completed" || item.status === "failed") && !item.pendingSubmissions?.length) continue;
    const linkedTasks = tasks.flatMap((task) => {
      const taskId = commerceTaskId(task);
      const operationKey = String(task.operationKey || "").trim();
      const scopedPending = item.pendingSubmissions?.find((candidate) => (
        candidate.operationKey
        && candidate.operationKey === operationKey
      ));
      if (scopedPending && taskId && !scopedPending.knownTaskIds.includes(taskId)) {
        return [{ ...task, submissionKey: scopedPending.key }];
      }
      if (scopedPending?.knownTaskIds.includes(taskId)) return [];
      return item.taskIds?.includes(taskId) ? [task] : [];
    });
    if (linkedTasks.length) next = linkCommerceVariantBatchTasks(next, item.id, linkedTasks, now);
  }
  return next;
}

export function commercePendingSubmissionForOperation(
  batch: CommerceVariantBatch,
  operationKey: string,
) {
  const normalizedOperationKey = operationKey.trim();
  if (!normalizedOperationKey) return null;
  for (const item of batch.items) {
    const pending = item.pendingSubmissions?.find((candidate) => candidate.operationKey === normalizedOperationKey);
    if (pending) return pending;
  }
  return null;
}

export function normalizeCommerceVariantBatch(value: unknown): CommerceVariantBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<CommerceVariantBatch>;
  if (source.version !== 1 || !Array.isArray(source.items)) return null;
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const validStatuses: CommerceVariantBatchStatus[] = ["ready", "editing", "completed", "failed"];
  const items = source.items.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Partial<CommerceVariantBatchItem>;
    const duration = Number(item.duration);
    const itemUpdatedAt = Number(item.updatedAt);
    if (
      typeof item.id !== "string"
      || !item.id.trim()
      || typeof item.label !== "string"
      || typeof item.ratio !== "string"
      || !/^\d+:\d+$/.test(item.ratio)
      || !Number.isFinite(duration)
      || duration < 5
      || duration > 300
      || typeof item.tone !== "string"
      || typeof item.audience !== "string"
      || !validStatuses.includes(item.status as CommerceVariantBatchStatus)
      || !Number.isFinite(itemUpdatedAt)
      || itemUpdatedAt <= 0
    ) return [];
    const taskIds = Array.isArray(item.taskIds) && item.taskIds.every((taskId) => typeof taskId === "string" && taskId.trim())
      ? [...new Set(item.taskIds.map((taskId) => taskId.trim()))].slice(0, 100)
      : [];
    const pendingSubmissions = Array.isArray(item.pendingSubmissions)
      ? item.pendingSubmissions.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const pending = entry as { key?: unknown; fingerprint?: unknown; operationKey?: unknown; knownTaskIds?: unknown };
          const key = typeof pending.key === "string" ? pending.key.trim() : "";
          const fingerprint = typeof pending.fingerprint === "string" ? pending.fingerprint.trim() : "";
          const operationKey = typeof pending.operationKey === "string" ? pending.operationKey.trim() : "";
          if (!key || !fingerprint || !operationKey || !Array.isArray(pending.knownTaskIds)) return [];
          const knownTaskIds = [...new Set(pending.knownTaskIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim()).filter(Boolean))].slice(0, 100);
          if (knownTaskIds.length !== pending.knownTaskIds.length) return [];
          return [{ key, fingerprint, operationKey, knownTaskIds }];
        }).slice(0, 100)
      : [];
    if (Array.isArray(item.pendingSubmissions) && pendingSubmissions.length !== item.pendingSubmissions.length) return [];
    const normalizedStatus = item.status === "completed" && (taskIds.length === 0 || pendingSubmissions.length > 0)
      ? "ready"
      : item.status as CommerceVariantBatchStatus;
    return [{
      id: item.id.trim(),
      label: item.label.trim(),
      ratio: item.ratio as QuickCreateRatio,
      duration,
      tone: item.tone.trim(),
      audience: item.audience.trim(),
      status: normalizedStatus,
      updatedAt: itemUpdatedAt,
      ...(typeof item.error === "string" && item.error.trim() ? { error: item.error.trim().slice(0, 500) } : {}),
      ...(taskIds.length ? { taskIds } : {}),
      ...(pendingSubmissions.length ? { pendingSubmissions } : {}),
      ...(Array.isArray(item.resultUrls) && item.resultUrls.every((url) => typeof url === "string" && url.trim())
        ? { resultUrls: [...new Set(item.resultUrls.map((url) => url.trim()))].slice(0, 100) }
        : {}),
    }];
  }).slice(0, 24);
  if (items.length !== source.items.length) return null;
  const activeItemId = typeof source.activeItemId === "string"
    && items.some((item) => item.id === source.activeItemId && item.status === "editing")
    ? source.activeItemId
    : undefined;
  return { version: 1, createdAt, updatedAt, items, ...(activeItemId ? { activeItemId } : {}) };
}

export function createEditRevisionBundle(
  source: AutoEditTimelineItem[],
  automatic: AutoEditTimelineItem[],
  savedAt = Date.now(),
  manual: AutoEditTimelineItem[] = automatic,
): EditRevisionBundle {
  return {
    source: { timeline: cloneTimeline(source), savedAt },
    automatic: { timeline: cloneTimeline(automatic), savedAt },
    manual: { timeline: cloneTimeline(manual), savedAt },
  };
}

export function updateManualEditRevision(
  bundle: EditRevisionBundle,
  manual: AutoEditTimelineItem[],
  savedAt = Date.now(),
): EditRevisionBundle {
  const nextManualTimeline = cloneTimeline(manual);
  const manualSavedAt = JSON.stringify(nextManualTimeline) === JSON.stringify(bundle.manual.timeline)
    ? bundle.manual.savedAt
    : savedAt;
  return {
    source: { timeline: cloneTimeline(bundle.source.timeline), savedAt: bundle.source.savedAt },
    automatic: { timeline: cloneTimeline(bundle.automatic.timeline), savedAt: bundle.automatic.savedAt },
    manual: { timeline: nextManualTimeline, savedAt: manualSavedAt },
  };
}
