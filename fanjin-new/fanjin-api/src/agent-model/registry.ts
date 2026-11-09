/**
 * ModelProvider 注册表（单例）。按 modelId 精确命中或前缀工厂路由。
 */
import type { ModelProvider, ModelProviderFactory } from "./provider";
import { MockModelProvider } from "./mockProvider";
import { ModelProviderNotFoundError } from "./errors";

/** 模型供应商注册表（单例） */
export class ModelProviderRegistry {
  private static instance: ModelProviderRegistry | null = null;
  private readonly factories = new Map<string, ModelProviderFactory>();
  private readonly providers = new Map<string, ModelProvider>();

  private constructor() {
    // Synthetic providers are test fixtures only. Registering this prefix in
    // production would let a misconfigured `mock-*` model return fabricated
    // successful output to users instead of failing closed.
    if (process.env.NODE_ENV === "test") {
      this.factories.set("mock", (modelId) => new MockModelProvider({ modelId }));
    }
  }

  /** 获取单例实例 */
  static getInstance(): ModelProviderRegistry {
    if (!this.instance) this.instance = new ModelProviderRegistry();
    return this.instance;
  }

  /** 注册前缀工厂 */
  registerFactory(prefix: string, factory: ModelProviderFactory): void {
    this.factories.set(prefix, factory);
  }

  /** 注册精确 modelId 的 Provider */
  registerProvider(modelId: string, provider: ModelProvider): void {
    this.providers.set(modelId, provider);
  }

  /** 获取 Provider：先查精确缓存，再按前缀命中工厂并缓存，都不中则抛错 */
  getProvider(modelId: string): ModelProvider {
    const cached = this.providers.get(modelId);
    if (cached) return cached;
    for (const [prefix, factory] of this.factories) {
      if (modelId.startsWith(prefix)) {
        const p = factory(modelId);
        this.providers.set(modelId, p);
        return p;
      }
    }
    throw new ModelProviderNotFoundError(modelId);
  }

  /** 测试用：清空实例缓存 */
  clear(): void { this.providers.clear(); }
}

/** 按 modelId 获取 Provider（便捷函数） */
export function getModelProvider(modelId: string): ModelProvider {
  return ModelProviderRegistry.getInstance().getProvider(modelId);
}

/** 注册精确 modelId 的 Provider（便捷函数） */
export function registerModelProvider(modelId: string, provider: ModelProvider): void {
  ModelProviderRegistry.getInstance().registerProvider(modelId, provider);
}
