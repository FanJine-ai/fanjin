/**
 * 复用现有 registry 的 catalog 投影，产出模型可见工具定义。
 * R4 永拒、preview/disabled 过滤等规则全在 registry/catalog 内，这里不重复实现。
 */
import type { AgentToolCatalogContext, AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";
import type { ToolCatalogPort } from "./ports";

/** ToolCatalogPort 实现：委托注入的 catalog context。 */
export class RegistryCatalogAdapter implements ToolCatalogPort {
  private readonly catalog: AgentToolCatalogContext;

  constructor(catalog: AgentToolCatalogContext) {
    this.catalog = catalog;
  }

  /** 返回角色可见的工具定义列表（R4/preview/disabled 已在 registry 内过滤）。 */
  list(): readonly AgentToolCatalogDefinition[] {
    return this.catalog.list();
  }
}
