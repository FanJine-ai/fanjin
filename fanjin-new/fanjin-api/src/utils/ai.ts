import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
const devToolsMiddleware = (): never => { throw new Error("AI debug server is excluded from the public profile"); };
import axios from "axios";
import type { Knex } from "knex";
import { transform } from "sucrase";
import u from "@/utils";
import {
  beginCreationBillingSession,
  failCreationBillingSession,
  markCreationBillingDispatched,
  settleCreationBillingSession,
  type CreationChargeInput,
} from "@/lib/creationBilling";
import { isBillingSkipped } from "@/lib/billingContext";
import {
  assertLegacyVendorCredentialMaterializationAllowed,
  resolveVendorRuntimeInputs,
} from "@/lib/vendorCredentialResolver";
import {
  runWithProjectTaskOutput,
  runWithProjectTaskRecord,
} from "@/utils/taskRecord";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
} from "@/lib/objectWriteIntent";
import {
  inspectVendorVmSource,
  VENDOR_VM_SOURCE_POLICY_ERROR,
} from "@/lib/vendorVmSafety";

type AiType =
  | "scriptAgent"
  | "productionAgent"
  | "universalAi"
  | "scriptAgent:decisionAgent"
  | "scriptAgent:supervisionAgent"
  | "scriptAgent:storySkeletonAgent"
  | "scriptAgent:adaptationStrategyAgent"
  | "scriptAgent:scriptAgent"
  | "productionAgent:decisionAgent"
  | "productionAgent:supervisionAgent"
  | "productionAgent:deriveAssetsAgent"
  | "productionAgent:generateAssetsAgent"
  | "productionAgent:directorPlanAgent"
  | "productionAgent:storyboardGenAgent"
  | "productionAgent:storyboardPanelAgent"
  | "productionAgent:storyboardTableAgent";

type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: AiType[] = [
  "scriptAgent",
  "productionAgent",
  "universalAi",
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
  "universalAi",
];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  assertLegacyVendorCredentialMaterializationAllowed();
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();

    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData?.modelName as `${number}:${string}`;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData?.modelName as `${number}:${string}`;
    }

    //未查到agentUseModeVal 维持原判断
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    if (!agentDeployData) throw new Error(`未找到部署配置 ${value}`);
    let modelName = null;

    if (!agentDeployData.modelName) {
      if (!agentDeployData.key) throw new Error(`未找到部署配置 ${value}`);
      const [mainly] = String(agentDeployData.key).split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      modelName = mainlyData.modelName;
    }
    modelName = agentDeployData.modelName || modelName;
    return modelName as `${number}:${string}`;
  }
  return value as `${number}:${string}`;
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  assertLegacyVendorCredentialMaterializationAllowed();
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();
    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData;
    }

    //未查到 agentUseModelVal 维持原流程
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    if (!agentDeployData) throw new Error(`未找到部署配置 ${value}`);

    if (!agentDeployData.modelName) {
      if (!agentDeployData.key) throw new Error(`未找到部署配置 ${value}`);
      const [mainly] = String(agentDeployData.key).split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      return mainlyData;
    }
    return agentDeployData;
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  assertLegacyVendorCredentialMaterializationAllowed();
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const code = u.vendor.getCode(id);
  if (
    process.env.NODE_ENV === "prod"
    && !inspectVendorVmSource(id, code).ready
  ) {
    throw new Error(VENDOR_VM_SOURCE_POLICY_ERROR);
  }
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const running = u.vm(jsCode);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, resolveVendorRuntimeInputs(vendorConfigData.inputValues, process.env, id));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
  imageId?: number,
): Promise<T> {
  assertLegacyVendorCredentialMaterializationAllowed();
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  return await runWithProjectTaskRecord(
    u.db,
    {
      projectId,
      imageId,
      taskClass,
      modelName: model,
      describe,
      content: relatedObjects,
    },
    async () => await fn(modelName, false, 0),
  );
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}

// 缺少 usage 时按字符粗略估算 token，避免漏计费（仅 fallback）
function estimateTokens(input: any, text?: string): number {
  const messages = (input?.messages as any[]) || [];
  const promptChars = messages.reduce((sum, msg) => sum + String(msg?.content ?? "").length, 0);
  const outputChars = String(text ?? "").length;
  return Math.max(1, Math.round((promptChars + outputChars) / 3));
}

// 从 completion.usage 生成结算输入；缺少 usage 时按文本长度保守回退。
function creationTextChargeInput(
  modelName: string,
  completion: any,
  requestInput?: unknown,
  descriptionPrefix = "creation text",
): CreationChargeInput {
  const usage = completion?.usage;
  const inputTokens = Number(usage?.inputTokens) || 0;
  const outputTokens = Number(usage?.outputTokens) || 0;
  const cacheTokens = Number(usage?.inputTokenDetails?.cacheReadTokens) || Number(usage?.cachedInputTokens) || 0;
  const tokens = Number(usage?.totalTokens) || inputTokens + outputTokens || estimateTokens(requestInput, completion?.text);
  const hasTokenBreakdown = inputTokens > 0 || outputTokens > 0;
  return {
    endpointType: "text",
    model: modelName,
    units: Math.max(1, tokens),
    unit: "token",
    description: `${descriptionPrefix}: ${modelName.split(/:(.+)/)[1] || modelName}`,
    ...(hasTokenBreakdown ? { tokenBreakdown: { inputTokens, outputTokens, cacheTokens } } : {}),
  };
}

class AiText {
  private AiType: AiType | `${string}:${string}`;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[]) {
    assertLegacyVendorCredentialMaterializationAllowed();
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(false ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    assertLegacyVendorCredentialMaterializationAllowed();
    const config = await getModelConfig(this.AiType);
    const modelName = await resolveModelName(this.AiType);
    const inputChars = (input.messages as any[])?.reduce((sum, msg) => sum + String(msg?.content ?? "").length, 0) ?? 0;
    const estimatedInputTokens = Math.ceil(inputChars / 3);
    const estimatedOutputTokens = Number(config?.maxOutputTokens) || 4096;
    const estimatedCharge: CreationChargeInput = {
      endpointType: "text",
      model: modelName,
      units: Math.max(1, estimatedInputTokens + estimatedOutputTokens),
      unit: "token",
      description: `creation text: ${modelName.split(/:(.+)/)[1] || modelName}`,
      tokenBreakdown: { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens, cacheTokens: 0 },
    };
    const billingSession = isBillingSkipped() ? null : await beginCreationBillingSession(estimatedCharge);
    try {
      const resolvedModel = await this.resolveModel();
      await markCreationBillingDispatched(billingSession);
      const result = await generateText({
        ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
        ...input,
        model: resolvedModel,
        ...(config?.temperature && { temperature: config.temperature }),
        ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      } as Parameters<typeof generateText>[0]);
      await settleCreationBillingSession(
        billingSession,
        creationTextChargeInput(modelName, result, input, "creation text"),
      );
      return result;
    } catch (error) {
      await failCreationBillingSession(billingSession, estimatedCharge, error);
      throw error;
    }
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    assertLegacyVendorCredentialMaterializationAllowed();
    const config = await getModelConfig(this.AiType);
    const AiTypeRef = this.AiType;
    const userOnFinish = input.onFinish as Parameters<typeof streamText>[0]["onFinish"] | undefined;
    const userOnError = input.onError as Parameters<typeof streamText>[0]["onError"] | undefined;
    const userOnAbort = input.onAbort as Parameters<typeof streamText>[0]["onAbort"] | undefined;
    const modelName = await resolveModelName(AiTypeRef);
    const inputChars = (input.messages as any[])?.reduce((sum, msg) => sum + String(msg?.content ?? "").length, 0) ?? 0;
    const estimatedInputTokens = Math.ceil(inputChars / 3);
    const estimatedOutputTokens = Number(config?.maxOutputTokens) || 4096;
    const estimatedCharge: CreationChargeInput = {
      endpointType: "text",
      model: modelName,
      units: Math.max(1, estimatedInputTokens + estimatedOutputTokens),
      unit: "token",
      description: `creation text stream: ${modelName.split(/:(.+)/)[1] || modelName}`,
      tokenBreakdown: { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens, cacheTokens: 0 },
    };
    const billingSession = isBillingSkipped() ? null : await beginCreationBillingSession(estimatedCharge);
    try {
      const resolvedModel = await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" }));
      await markCreationBillingDispatched(billingSession);
      return streamText({
        ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
        ...input,
        model: resolvedModel,
        ...(config?.temperature && { temperature: config.temperature }),
        ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
        // 流式调用结束后按真实 token 结算；provider 错误保留冻结进入核账。
        onFinish: async (completion) => {
          try {
            await userOnFinish?.(completion);
          } finally {
            await settleCreationBillingSession(
              billingSession,
              creationTextChargeInput(modelName, completion, input, "creation text stream"),
            );
          }
        },
        onError: async (event) => {
          try {
            await userOnError?.(event);
          } finally {
            const cause = event.error;
            await failCreationBillingSession(billingSession, estimatedCharge, cause);
          }
        },
        onAbort: async (event) => {
          try {
            await userOnAbort?.(event);
          } finally {
            await failCreationBillingSession(
              billingSession,
              estimatedCharge,
              new Error("creation text stream aborted after dispatch"),
            );
          }
        },
      } as Parameters<typeof streamText>[0]);
    } catch (error) {
      await failCreationBillingSession(billingSession, estimatedCharge, error);
      throw error;
    }
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string } | { type: "audio"; base64: string } | { type: "video"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
  imageId?: number; // 图片生产者栅栏，阻止同一图片并发删除
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  private async execute(
    input: ImageConfig,
    modelName: `${string}:${string}`,
  ): Promise<this> {
    assertLegacyVendorCredentialMaterializationAllowed();
    const charge: CreationChargeInput = {
      endpointType: "image_generation",
      model: modelName,
      units: 1,
      unit: "image",
      description: `creation image: ${modelName.split(/:(.+)/)[1] || modelName}`,
    };
    const billingSession = isBillingSkipped()
      ? null
      : await beginCreationBillingSession(charge);
    try {
      const fn = await getVendorTemplateFn("imageRequest", modelName);
      await referenceList2imageBase642(
        modelName.split(/:(.+)/)[0],
        input,
      );
      await markCreationBillingDispatched(billingSession);
      this.result = await fn(input);
      await settleCreationBillingSession(billingSession, charge);
      if (this.result.startsWith("http")) {
        this.result = await urlToBase64(this.result);
      }
      return this;
    } catch (error) {
      await failCreationBillingSession(billingSession, charge, error);
      throw error;
    }
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    assertLegacyVendorCredentialMaterializationAllowed();
    if (taskRecord) {
      await withTaskRecord(
        this.key,
        taskRecord.taskClass,
        taskRecord.describe,
        taskRecord.relatedObjects,
        taskRecord.projectId,
        async (modelName) => await this.execute(input, modelName),
        taskRecord.imageId,
      );
      return this;
    }
    await this.execute(input, await resolveModelName(this.key));
    return this;
  }
  async runAndPersist<T>(
    input: ImageConfig,
    taskRecord: TaskRecord,
    outputPath: string,
    persist: (
      transaction: Knex.Transaction,
      storageKey: string,
    ) => Promise<T>,
  ): Promise<T> {
    assertLegacyVendorCredentialMaterializationAllowed();
    const normalizedPath = outputPath
      .replace(/\\/gu, "/")
      .replace(/^\/+/u, "");
    if (
      normalizedPath.includes("../")
      || !normalizedPath.startsWith(`${taskRecord.projectId}/`)
    ) {
      throw new Error("生成图片必须写入所属项目的对象存储命名空间");
    }
    const fileName = normalizedPath.split("/").at(-1) || "";
    const intentId = fileName.replace(/\.[^.]+$/u, "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(intentId)
    ) {
      throw new Error("生成图片路径必须包含唯一 UUID 文件名");
    }
    const modelName = await resolveModelName(this.key);
    const model = modelName.split(/:(.+)/)[1];
    let durableWrite: DurableObjectWriteResult | null = null;
    return await runWithProjectTaskOutput(
      u.db,
      {
        projectId: taskRecord.projectId,
        imageId: taskRecord.imageId,
        outputStorageKey: normalizedPath,
        taskClass: taskRecord.taskClass,
        modelName: model,
        describe: taskRecord.describe,
        content: taskRecord.relatedObjects,
      },
      {
        write: async () => {
          await this.execute(input, modelName);
          const body = Buffer.from(
            this.result.replace(/^data:[^;]+;base64,/u, ""),
            "base64",
          );
          durableWrite = await writeObjectWithDurableIntent({
            purpose: "agent_generation",
            workspaceId: String(
              (await u.db("o_project")
                .where({
                  id: taskRecord.projectId,
                  deletionState: "active",
                })
                .select("workspaceId")
                .first())?.workspaceId || "",
            ),
            projectId: taskRecord.projectId,
            body,
            storageKey: () => normalizedPath,
            writerIdPrefix: "creation-image",
          }, {
            database: u.db,
            idFactory: () => intentId,
            writer: u.oss,
          });
        },
        persist: async (transaction, storageKey, taskId) => {
          const persisted = await persist(transaction, storageKey);
          if (!durableWrite) {
            throw new Error("生成图片缺少 durable object write");
          }
          await commitObjectWriteIntentInTransaction(
            transaction,
            durableWrite.claim,
            {
              version: "object-write-reference.v1",
              table: "o_tasks",
              rowId: String(taskId),
              workspaceId: String(
                (await transaction("o_project")
                  .where({ id: taskRecord.projectId })
                  .select("workspaceId")
                  .first())?.workspaceId || "",
              ),
              projectId: taskRecord.projectId,
              storageKey,
            },
          );
          return persisted;
        },
        cleanup: async () => {
          if (!durableWrite) return;
          await queueDurableObjectWriteCompensation(
            durableWrite.claim,
            new Error("creation image business reference failed"),
            { database: u.db },
          );
        },
      },
    );
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    assertLegacyVendorCredentialMaterializationAllowed();
    const modelName = await resolveModelName(this.key);
    try {
      const exec = async (mn: `${string}:${string}`) => {
        const fn = await getVendorTemplateFn("videoRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);

        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      };
      if (taskRecord) {
        await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
        return this;
      }
      await exec(modelName);
      return this;
    } catch (e) {
      throw e;
    }
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    assertLegacyVendorCredentialMaterializationAllowed();
    const keyRef = this.key;
    const exec = async (mn: `${string}:${string}`) => {
      const charge: CreationChargeInput = {
        endpointType: "tts",
        model: mn,
        units: 1,
        unit: "task",
        description: `creation tts: ${mn.split(/:(.+)/)[1] || mn}`,
      };
      const billingSession = isBillingSkipped() ? null : await beginCreationBillingSession(charge);
      try {
        const fn = await getVendorTemplateFn("ttsRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
        await markCreationBillingDispatched(billingSession);
        this.result = await fn(input);
        await settleCreationBillingSession(billingSession, charge);
        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
        return this;
      } catch (error) {
        await failCreationBillingSession(billingSession, charge, error);
        throw error;
      }
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(await resolveModelName(keyRef));
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, think, thinkLevel),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
};
