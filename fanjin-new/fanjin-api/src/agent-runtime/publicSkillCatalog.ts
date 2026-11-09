import {
  AGENT_PUBLIC_SELECTABLE_SKILL_KEYS,
  AGENT_SKILL_REGISTRY,
} from "@/agent-runtime/runtimeConfigRegistry";
import type { AgentRole } from "@/agent-runtime/contracts";

export type PublicAgentSkillCatalogItem = {
  key: string;
  version: string;
  displayName: string;
  roles: AgentRole[];
  category: "story" | "commerce" | "design" | "brand";
  summary: string;
  useCases: string[];
  input: string;
  output: string;
  limits: string[];
  example: string;
  publisher: "Fanjin 官方";
  provenance: "runtime_registry";
  copyMode: "canonical_reference";
};

type PublicSkillMetadata = Omit<
  PublicAgentSkillCatalogItem,
  "key" | "version" | "displayName" | "roles" | "publisher" | "provenance" | "copyMode"
>;

const PUBLIC_SKILL_METADATA: Record<(typeof AGENT_PUBLIC_SELECTABLE_SKILL_KEYS)[number], PublicSkillMetadata> = {
  "official-story": {
    category: "story",
    summary: "把创意整理成有起承转合、适合短视频节奏的剧情方案。",
    useCases: ["剧情短片", "分场大纲", "关键画面规划"],
    input: "创作目标、受众、时长，以及可选的项目资产引用。",
    output: "剧情结构、分场建议与关键画面方向；不会自行发布成片。",
    limits: ["不替代素材授权确认", "是否生成及费用仍由当前模型与任务门禁决定"],
    example: "将一段产品创意整理为 30 秒三幕式短片方案。",
  },
  "official-commerce": {
    category: "commerce",
    summary: "围绕产品卖点组织主图、场景图与系列化电商视觉。",
    useCases: ["电商套图", "卖点梳理", "系列视觉规划"],
    input: "产品信息、核心卖点、目标渠道，以及可选的项目资产引用。",
    output: "卖点清单、使用场景和统一的视觉方向；不会自行上架商品。",
    limits: ["不验证商品宣称的法律真实性", "是否生成及费用仍由当前模型与任务门禁决定"],
    example: "为一款户外水杯规划主图与三张场景图。",
  },
  "official-poster": {
    category: "design",
    summary: "为传播场景规划主视觉、文案层级和行动号召。",
    useCases: ["活动海报", "品牌传播图", "主视觉结构"],
    input: "传播目标、主题文案、版式比例，以及可选的项目资产引用。",
    output: "主视觉与文案结构建议；不会绕过字体、肖像或素材授权。",
    limits: ["不提供版权或合规结论", "是否生成及费用仍由当前模型与任务门禁决定"],
    example: "为新品发布会整理一版 9:16 海报结构。",
  },
  "official-brand": {
    category: "brand",
    summary: "先明确品牌关键词与视觉语言，再约束后续产出的调性一致性。",
    useCases: ["品牌视觉方向", "系列内容一致性", "语气与风格约束"],
    input: "品牌定位、受众、关键词、已有视觉规范与项目资产引用。",
    output: "色彩、字体气质、图形元素和表达语气建议；不会创建商标权利。",
    limits: ["不替代品牌或商标审查", "是否生成及费用仍由当前模型与任务门禁决定"],
    example: "为一个年轻化茶饮品牌建立系列海报的视觉约束。",
  },
};

/**
 * Build the ordinary-user catalog from an explicit allowlist plus reviewed,
 * presentation-only metadata. Runtime instructions, hashes and legacy source
 * paths deliberately never cross this boundary.
 */
export function listPublicAgentSkills(): PublicAgentSkillCatalogItem[] {
  const publicKeys = new Set<string>(AGENT_PUBLIC_SELECTABLE_SKILL_KEYS);
  return AGENT_SKILL_REGISTRY
    .filter((skill) => publicKeys.has(skill.key))
    .map((skill) => {
      const metadata = PUBLIC_SKILL_METADATA[skill.key as keyof typeof PUBLIC_SKILL_METADATA];
      if (!metadata) throw new Error(`Public skill metadata missing: ${skill.key}`);
      return {
        key: skill.key,
        version: skill.version,
        displayName: skill.displayName,
        roles: [...skill.roles],
        ...metadata,
        publisher: "Fanjin 官方" as const,
        provenance: "runtime_registry" as const,
        copyMode: "canonical_reference" as const,
      };
    });
}
