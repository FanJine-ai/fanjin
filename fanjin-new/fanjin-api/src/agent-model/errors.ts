/**
 * Agent Model 层错误定义。
 */

/** 模型供应商未注册错误 */
export class ModelProviderNotFoundError extends Error {
  readonly modelId: string;
  constructor(modelId: string) {
    super(`未注册的 ModelProvider: ${modelId}`);
    this.name = "ModelProviderNotFoundError";
    this.modelId = modelId;
  }
}

export type ModelProviderStreamErrorCode = "model_stream_failed" | "model_stream_incomplete";

/** Relay SSE 已返回显式错误，或未以 [DONE] 完整结束。 */
export class ModelProviderStreamError extends Error {
  readonly code: ModelProviderStreamErrorCode;
  readonly providerErrorType?: string;

  constructor(code: ModelProviderStreamErrorCode, message: string, providerErrorType?: string) {
    super(message);
    this.name = "ModelProviderStreamError";
    this.code = code;
    this.providerErrorType = providerErrorType;
  }
}
