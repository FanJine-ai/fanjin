import type { ProviderChannelImageXReviewCredential } from "@/lib/providerChannelCredentials";
import { signVolcengineV4 } from "@/lib/volcengineV4";
import { assertProviderDispatchAllowed } from "@/lib/relayChannelCredential";

type Check = { name: string; status: "passed" | "failed" | "unverified"; httpStatus: number | null; code: string | null; requestId: string | null; message: string };
const identifier = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(v) && !v.startsWith("AKLT") ? v : null;

async function jsonResponse(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new Error("response too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Metadata GETs and deliberately incomplete requests only: never supply an
 * image/video URI, create an audit job, or equate a 400 with full permission. */
export async function inspectImageXService(credential: ProviderChannelImageXReviewCredential, fetcher: typeof fetch = fetch) {
  assertProviderDispatchAllowed();
  const operations = [
    { name: "服务审批", action: "GetImageService", version: "2018-08-01", query: { ServiceId: credential.serviceId } },
    { name: "基础订阅", action: "GetImageServiceSubscription", version: "2023-05-01", query: {} },
    { name: "AI 订阅", action: "GetImageServiceSubscription", version: "2023-05-01", query: { AddOnType: "AI" } },
    { name: "人脸检测权限探针", action: "GetImageDetectResult", version: "2023-05-01", query: { ServiceId: credential.serviceId }, body: { DetectType: "face" } },
    { name: "图片审核权限探针", action: "SingleImageAudit", version: "2023-05-01", query: { ServiceId: credential.serviceId }, body: { AuditAbility: 1, AuditDimensions: ["porn"], Async: 0 } },
  ];
  const checks: Check[] = await Promise.all(operations.map(async (operation): Promise<Check> => {
    try {
      const method = operation.body ? "POST" : "GET";
      const body = operation.body ? JSON.stringify(operation.body) : undefined;
      const query = Object.fromEntries(Object.entries({ Action: operation.action, Version: operation.version, ...operation.query }).filter(([, value]) => value !== undefined)) as Record<string, string>;
      const signed = signVolcengineV4({ ...credential, host: "imagex.volcengineapi.com", region: "cn-north-1", service: "imagex", method, at: new Date(), query, body });
      const response = await fetcher(`https://imagex.volcengineapi.com/?${signed.canonicalQuery}`, { method, body, headers: signed.headers, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000) });
      const payload = await jsonResponse(response);
      const error = payload?.ResponseMetadata?.Error;
      const code = identifier(error?.Code);
      let status: Check["status"] = "failed";
      let message = "检查失败，请核对服务配置与调用权限";
      if (operation.body) {
        if (response.status === 400 && code && (
          /^(InvalidParameter|MissingParameter)(\.|$)/u.test(code)
          || (operation.action === "GetImageDetectResult" && code === "InternalError.DownloadImg")
        )) {
          status = "unverified";
          message = "无素材探针未被明确拒绝；不证明完整授权，仍需真实素材验收";
        }
      } else if (response.ok && !error) {
        const result = payload?.Result;
        const ready = operation.action === "GetImageService"
          ? result?.ServiceId === credential.serviceId && result?.ServiceStatus === "正常"
          : Number(result?.Status) === 1 && Number(result?.BusinessStatus) === 1;
        status = ready ? "passed" : "failed";
        message = ready ? "正常" : "服务尚未审核通过、订阅不可用或响应缺少有效状态";
      }
      return { name: operation.name, status, httpStatus: response.status, code, requestId: identifier(payload?.ResponseMetadata?.RequestId), message };
    } catch {
      return { name: operation.name, status: "failed", httpStatus: null, code: "IMAGEX_CHECK_UNAVAILABLE", requestId: null, message: "连接超时或响应无效，请稍后重试" };
    }
  }));
  const ok = checks.every(check => check.status !== "failed");
  return { ok, checks, processingVerified: false as const, message: ok
    ? "基础服务状态正常；无素材权限探针未发现明确拒绝，真实检测和审核尚未验收"
    : "ImageX 配置检查未通过，请查看分项结果修复；未提交任何素材" };
}
