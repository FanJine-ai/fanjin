import { describe, it, expect, beforeEach } from "vitest";
import { ModelProviderRegistry, getModelProvider, registerModelProvider } from "@/agent-model/registry";
import { MockModelProvider } from "@/agent-model/mockProvider";
import { ModelProviderNotFoundError } from "@/agent-model/errors";

describe("ModelProviderRegistry", () => {
  let registry: ModelProviderRegistry;

  beforeEach(() => {
    registry = ModelProviderRegistry.getInstance();
    registry.clear();
  });

  it("单例：getInstance 返回同一实例", () => {
    const a = ModelProviderRegistry.getInstance();
    const b = ModelProviderRegistry.getInstance();
    expect(a).toBe(b);
  });

  it("默认 mock 前缀工厂：mock-xxx 可获取 Provider", () => {
    const p = registry.getProvider("mock-gpt4");
    expect(p).toBeInstanceOf(MockModelProvider);
    expect(p.metadata.modelId).toBe("mock-gpt4");
  });

  it("精确缓存：同 modelId 返回同一实例", () => {
    const p1 = registry.getProvider("mock-abc");
    const p2 = registry.getProvider("mock-abc");
    expect(p1).toBe(p2);
  });

  it("registerProvider：精确注册优先于工厂", () => {
    const custom = new MockModelProvider({ modelId: "custom-1" });
    registry.registerProvider("mock-xxx", custom);
    const p = registry.getProvider("mock-xxx");
    expect(p).toBe(custom);
  });

  it("registerFactory：注册新前缀工厂", () => {
    registry.registerFactory("test-", (modelId) => new MockModelProvider({ modelId }));
    const p = registry.getProvider("test-model-1");
    expect(p).toBeInstanceOf(MockModelProvider);
    expect(p.metadata.modelId).toBe("test-model-1");
  });

  it("clear：清空缓存后工厂重新创建实例", () => {
    const p1 = registry.getProvider("mock-clear-test");
    registry.clear();
    const p2 = registry.getProvider("mock-clear-test");
    expect(p2).not.toBe(p1); // 新实例
    expect(p2.metadata.modelId).toBe("mock-clear-test");
  });

  it("未注册前缀抛出 ModelProviderNotFoundError", () => {
    expect(() => registry.getProvider("unknown-model")).toThrow(ModelProviderNotFoundError);
    expect(() => registry.getProvider("unknown-model")).toThrow("未注册的 ModelProvider: unknown-model");
  });

  it("ModelProviderNotFoundError 包含 modelId", () => {
    try {
      registry.getProvider("bad-model");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelProviderNotFoundError);
      expect((e as ModelProviderNotFoundError).modelId).toBe("bad-model");
    }
  });
});

describe("便捷函数", () => {
  it("getModelProvider 按前缀获取", () => {
    const p = getModelProvider("mock-convenience");
    expect(p).toBeInstanceOf(MockModelProvider);
  });

  it("registerModelProvider 精确注册", () => {
    const custom = new MockModelProvider({ modelId: "my-custom" });
    registerModelProvider("my-custom", custom);
    expect(getModelProvider("my-custom")).toBe(custom);
  });
});
