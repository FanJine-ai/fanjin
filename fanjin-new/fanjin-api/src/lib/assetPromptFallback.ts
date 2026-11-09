type ProjectPromptContext = {
  artStyle?: string | null;
  type?: string | null;
  intro?: string | null;
};

type AssetPromptConfig = {
  label: string;
  nameLabel: string;
};

export function normalizeAssetType(type: string | null | undefined): "role" | "scene" | "tool" | null {
  if (type === "role" || type === "scene" || type === "tool") return type;
  if (type === "prop" || type === "props") return "tool";
  return null;
}

export function buildFallbackAssetPromptSystem(project: ProjectPromptContext, config: AssetPromptConfig): string {
  const artStyle = project.artStyle?.trim() || "写实电影感，构图清晰，主体明确，适合短剧视频制作";
  const projectType = project.type?.trim() || "短剧";
  const intro = project.intro?.trim() || "无";

  return `
你是短剧资产视觉提示词生成助手。当前项目没有绑定完整视觉手册，请根据项目画风和资产描述生成可直接用于 AI 图片生成的提示词。

项目类型：${projectType}
项目简介：${intro}
项目画风：${artStyle}
资产目标：${config.label}

输出要求：
1. 只输出一段最终图片生成提示词，不要解释，不要 Markdown。
2. 提示词必须保留资产名称和关键视觉特征。
3. 风格必须贴合项目画风，适合后续分镜和视频生成保持一致。
4. ${config.nameLabel}提示词要具体描述外观、材质、光线、构图和氛围。
5. 角色资产强调人物外观、服饰、气质、表情，场景资产强调空间结构、光影、色调，道具资产强调形状、材质、细节。
`.trim();
}
