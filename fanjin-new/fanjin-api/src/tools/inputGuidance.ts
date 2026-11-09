import { z } from "zod";
import { ToolError } from "./contracts";

export function invalidToolArguments(error: z.ZodError): ToolError {
  const leaves = (issues: readonly any[]): any[] => issues.flatMap(issue => issue.code === "invalid_union"
    ? (issue.errors || []).flatMap((nested: any[]) => leaves(nested)) : [issue]);
  const fields = leaves(error.issues).slice(0, 8).map(issue => ({
    field: issue.path.map((part: unknown) => String(part).replace(/[^\w-]/g, "").slice(0, 80)).join(".") || "request",
    code: issue.code,
    hint: issue.code === "unrecognized_keys" ? "移除工具定义以外的字段"
      : issue.code === "invalid_value" ? `请选择：${(issue.values || []).join("、")}`
      : issue.code === "too_big" ? `不能超过 ${String(issue.maximum)}`
      : issue.code === "too_small" ? `不能小于 ${String(issue.minimum)}`
      : issue.code === "invalid_type" ? `请提供 ${String(issue.expected)} 类型的值`
      : "请按该字段定义填写；生成参数可先查询模型能力",
  }));
  return new ToolError("INVALID_ARGUMENTS", `请修正参数：${[...new Set(fields.map(f => f.field))].join("、")}`, 400, { fields });
}
