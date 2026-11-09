const arkSources: Record<string, ArkSource> = {};
const jimeng: InspirationCase[] = [{ id: "synthetic-canvas-example", title: "Canvas example", source: "Synthetic local example", author: "Fanjin", category: "Example", kind: "skill", description: "Organize your own media in the canvas", videos: [], template: { inputs: ["Your own media"], steps: ["Describe your goal", "Arrange canvas nodes"], notes: ["No automatic paid generation"] } }];
const arkTemplates: Array<{ number: number; title: string; description: string; timecode: string }> = []; const windTemplates: typeof arkTemplates = []; const arkWork = { source: "Synthetic", author: "Fanjin", title: "Example" }; const windWork = arkWork;

export type CreativeGuide = {
  inputs: string[];
  steps: string[];
  notes?: string[];
  parameters?: { model: string; resolution: string; ratio: string; duration: number; mode: string };
};
export type SourceReference = { id: string; kind: "image" | "video" | "audio"; label: string; order: number; typeIndex: number; src: string; sourceUrl: string };
export type ArkSource = {
  templateId: string; workId: string; sourceUrl: string; model: string; ability: string;
  options: { ratio: string; resolution: string; duration: number; durationMode: string; generateAudio: boolean; outputCount: number; outputFormat: string };
  prompt: string; rawPrompt: string; references: SourceReference[];
  clip: { src: string; poster: string; duration: number };
  film: { src: string; duration: number }; startSeconds: number; endSeconds: number;
};
export type InspirationCase = {
  original?: ArkSource;
  id: string;
  title: string;
  source: string;
  author: string;
  category: string;
  kind: "skill" | "shot" | "watch";
  description: string;
  videos: { src: string; poster: string; duration: number }[];
  template: CreativeGuide | null;
  timecode?: string;
  segment?: number;
  workTitle?: string;
};

const editorialCases: InspirationCase[] = [
  ...jimeng.map(item => ({ ...item, kind: item.template ? "skill" as const : "watch" as const })),
  ...arkTemplates.map(item => ({
    id: `ark-small-hero-${item.number}`,
    title: item.title, source: arkWork.source, author: arkWork.author, category: "短剧影视",
    kind: "shot" as const, description: item.description, videos: [],
    timecode: item.timecode, segment: item.number, workTitle: arkWork.title,
    template: null,
  })),
  ...windTemplates.map(item => ({
    id: `ark-wind-${item.number}`,
    title: item.title, source: windWork.source, author: windWork.author, category: "短剧影视",
    kind: "shot" as const, description: item.description, videos: [],
    timecode: item.timecode, segment: item.number, workTitle: windWork.title,
    template: null,
  })),
];

export const showcaseCases: InspirationCase[] = editorialCases.map(item => {
  const original = (arkSources as Record<string, ArkSource>)[item.id];
  if (!original) return item;
  return { ...item, original, videos: [original.clip], template: {
    inputs: original.references.map(ref => ref.label), steps: [], notes: [],
    parameters: { model: "Seedance 2.5", resolution: original.options.resolution.toUpperCase(), ratio: original.options.ratio, duration: original.options.duration, mode: original.ability === "VideoEdit" ? "视频编辑" : "多模态参考" },
  } };
});

/** Translate original typed references to the actual composer slot; do not infer by filename. */
export function buildSourcePrompt(item: InspirationCase, idea: string, offset = 0): string {
  if (!item.original) return "";
  const prompt = item.original.rawPrompt.replace(/<<<(image|video|audio)_(\d+)_(\d+)>>>/g, (_token, kind, typed, slot) => {
    const reference = item.original!.references[Number(slot) - 1];
    if (!reference || reference.kind !== kind || reference.typeIndex !== Number(typed)) throw new Error("原始素材编号不一致");
    return `@参考${offset + Number(slot)}`;
  });
  return idea.trim() ? `${prompt}\n\n我的调整：${idea.trim()}` : prompt;
}

export const caseKindLabels = { skill: "技能模板", shot: "镜头模板", watch: "视频欣赏" };

/** A user-editable planning brief, never executable source tools or an automatic generation request. */
export function buildCreativeBrief(item: InspirationCase, idea: string): string {
  if (!item.template) return "";
  const { inputs, steps, notes, parameters } = item.template;
  return [
    `创作方向：${item.title}`,
    `我的想法：${idea.trim() || "请先和我一起明确主题、人物与目标。"}`,
    "\n创作指引（依据公开案例整理，可调整）：",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "\n需要准备的素材或信息：", ...inputs.map(input => `- ${input}`),
    ...(parameters ? [`\n原案例生成参数：${parameters.model} / ${parameters.resolution} / ${parameters.ratio} / ${parameters.duration}秒 / ${parameters.mode}。`] : []),
    ...(notes?.length ? ["\n需要确认：", ...notes.map(note => `- ${note}`)] : []),
    "\n请先检查我的素材与需求是否齐全，整理可执行的分镜与提示词供我确认。缺少参考素材时先提示我补充；模型、时长和参考数量以当前工作区能力为准。",
  ].join("\n");
}

export function appendCreativeBrief(current: string, incoming: string) {
  if (!current.trim()) return incoming;
  if (current.includes(incoming)) return current;
  return `${current.trimEnd()}\n\n—— 新增创作参考 ——\n${incoming}`;
}
