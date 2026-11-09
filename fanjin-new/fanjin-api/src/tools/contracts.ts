import { z } from "zod";
import { analyticsInputSchema, analyticsActions } from "@/analytics/contracts";
import { GenerationReferenceError } from "@/lib/generationReferenceError";
import { PortraitAdmissionWorkflowError } from "@/lib/portraitAdmissionError";
import { PortraitProviderRuntimeError } from "@/lib/portraitProviderError";
import { VideoPricingEstimateError } from "@/lib/videoTokenReservation";
import { creationToolDefinitions } from "./creationContracts";
import { canvasToolDefinitions } from "./canvasContracts";
import { studioToolDefinitions } from "./studioCatalog";
import { canvasRunDefinitions } from "./canvasRunContracts";
import { humanContinuationTool } from "./humanContinuation";

export const TOOL_API_VERSION = "fanjin-tools/v1";
export const MAX_TOOL_BYTES = 512 * 1024;
export const GU_UNITS = {
  guUnitVersion: "gu-cny-10/v1",
  guPerYuan: 10,
  guMicrosPerGu: "100000000",
  guMicrosPerYuan: "1000000000",
} as const;

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const page = {
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
};
const mediaType = z.enum(["image", "video"]);

export const toolDefinitions = {
  ...creationToolDefinitions,
  ...canvasToolDefinitions,
  ...canvasRunDefinitions,
  ...studioToolDefinitions,
  ...humanContinuationTool,
  fanjin_analytics_query: {
    title: "查询账号与工作区数据",
    description: "读取余额、用量汇总、调用明细、资金流水；支持游标导出，以及创建、查询、取消和下载后台导出任务。创建任务需 idempotencyKey，不修改余额。权限实时校验；账号限本人、工作区限绑定范围。金额以精确 GU 字符串返回。",
    keyPermission: null, memberPermission: "workspace:read", readOnly: false,
    schema: analyticsInputSchema.extend({ action: z.enum(analyticsActions) }).strict(),
  },
  fanjin_context_get: {
    title: "读取当前工具身份",
    description: "读取密钥绑定工作区和本次可用的工具，不返回凭据。",
    keyPermission: null, memberPermission: null,
    schema: z.strictObject({}),
  },
  fanjin_projects_list: {
    title: "列出繁境项目",
    description: "分页读取当前密钥所属工作区的项目。",
    keyPermission: "project:read", memberPermission: "project:read",
    schema: z.strictObject(page),
  },
  fanjin_project_get: {
    title: "读取繁境项目",
    description: "读取项目上下文；已在 MCP 地址绑定项目时可省略 projectId。",
    keyPermission: "project:read", memberPermission: "project:read",
    schema: z.strictObject({ projectId: id.optional() }),
  },
  fanjin_models_list: {
    title: "列出图片和视频模型",
    description: "读取工作台模型能力，并按密钥模型白名单过滤；配置可用不等于已完成实时供应商探测。",
    keyPermission: "model:read", memberPermission: "project:read",
    schema: z.strictObject({ ...page, type: mediaType.optional(), available: z.boolean().default(false) }),
  },
  fanjin_model_get: {
    title: "读取模型能力",
    description: "按列表返回的 modelId 和类型读取已配置的分辨率、比例、时长等能力。",
    keyPermission: "model:read", memberPermission: "project:read",
    schema: z.strictObject({ modelId: z.string().min(1).max(200), type: mediaType.optional() }),
  },
  fanjin_billing_balance: {
    title: "读取工作区账本余额",
    description: "只读工作区账本，按 1 元等于 10 GU 返回精确金额；不包含个人钱包和赠送余额，也不代表生成预算审批。",
    keyPermission: "billing:read", memberPermission: "billing:read",
    schema: z.strictObject({}),
  },
  fanjin_canvas_get: {
    title: "读取持久化画布摘要",
    description: "读取已保存画布的 revision、节点位置、标签、资产版本和连接摘要。includeContent=true 可读取提示词/文本供编辑；不包含浏览器未保存内容，不返回任意内部字段。",
    keyPermission: "project:read", memberPermission: "project:read",
    schema: z.strictObject({ projectId: id.optional(), canvasId: id.optional(), includeContent: z.boolean().default(false), nodeOffset: z.number().int().min(0).default(0), edgeOffset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(500) }),
  },
} as const;

export type ToolName = keyof typeof toolDefinitions;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolDefinitions)[N]["schema"]>;
export class ToolError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: Record<string, unknown>) { super(message); }
}
export type ToolResponse = {
  apiVersion: typeof TOOL_API_VERSION;
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

export function toolFailure(error: unknown, requestId: string): { status: number; body: ToolResponse } {
  const safe = error instanceof ToolError || error instanceof GenerationReferenceError
    || error instanceof VideoPricingEstimateError
    || error instanceof PortraitAdmissionWorkflowError || error instanceof PortraitProviderRuntimeError
    ? error : new ToolError("INTERNAL_ERROR", "工具暂时不可用，请稍后重试", 500);
  return { status: safe.status, body: { apiVersion: TOOL_API_VERSION, requestId, ok: false, error: { code: safe.code, message: safe.message,
    ...(safe instanceof ToolError && safe.details ? { details: safe.details } : {}) } } };
}

export function assertToolSize(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ToolError("INVALID_ARGUMENTS", "工具参数必须是 JSON 对象");
  if (Buffer.byteLength(encoded, "utf8") > MAX_TOOL_BYTES) {
    throw new ToolError("PAYLOAD_TOO_LARGE", "工具数据超过 512 KiB 上限，请缩小查询范围", 413);
  }
}

export function ledgerAmount(raw: unknown): bigint {
  if ((typeof raw === "number" && Number.isSafeInteger(raw)) || (typeof raw === "string" && /^-?\d+$/.test(raw))) {
    return BigInt(raw);
  }
  throw new ToolError("INVALID_LEDGER_AMOUNT", "账本金额精度异常，暂不返回余额", 503);
}

export function guAmount(atoms: bigint) {
  const sign = atoms < 0n ? "-" : "";
  const absolute = atoms < 0n ? -atoms : atoms;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return { guMicros: atoms.toString(), gu: `${sign}${absolute / 100_000_000n}${fraction ? `.${fraction}` : ""}` };
}

/** Display-only conversion; never changes ledger atoms or charge rounding. */
export function moneyAmount(atoms: bigint) {
  const negative = atoms < 0n, absolute = negative ? -atoms : atoms;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return { ...guAmount(atoms), yuan: `${negative ? "-" : ""}${absolute / 1_000_000_000n}${fraction ? `.${fraction}` : ""}` };
}
