import { describe, it, expect, vi } from "vitest";
import { RegistryCatalogAdapter } from "../catalogAdapter";
import type { AgentToolCatalogContext, AgentToolCatalogDefinition } from "@/agent-runtime/tools/registry";

describe("RegistryCatalogAdapter", () => {
  it("list() 委托 catalog context 的 list()", () => {
    const defs = [
      { manifest: { name: "search" } as unknown as AgentToolCatalogDefinition["manifest"], inputSchema: {} },
    ] as unknown as AgentToolCatalogDefinition[];
    const catalog = {
      list: vi.fn().mockReturnValue(defs),
      describe: vi.fn(),
    } as unknown as AgentToolCatalogContext;

    const adapter = new RegistryCatalogAdapter(catalog);
    const result = adapter.list();

    expect(result).toBe(defs);
    expect(catalog.list).toHaveBeenCalledTimes(1);
  });

  it("空目录返回空数组", () => {
    const catalog = {
      list: vi.fn().mockReturnValue([]),
      describe: vi.fn(),
    } as unknown as AgentToolCatalogContext;

    const adapter = new RegistryCatalogAdapter(catalog);
    expect(adapter.list()).toEqual([]);
  });
});
