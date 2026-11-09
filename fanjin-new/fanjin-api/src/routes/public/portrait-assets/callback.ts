import express from "express";

import {
  completePortraitLivenessCallback,
  PortraitProviderRuntimeError,
} from "@/lib/portraitProviderRuntime";

const router = express.Router();

function callbackValue(value: unknown, maximum: number): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = String(raw ?? "").trim();
  return parsed.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(parsed) ? parsed : "";
}

function html(status: "succeeded" | "failed" | "expired"): string {
  const succeeded = status === "succeeded";
  const title = succeeded ? "真人授权已完成" : status === "expired" ? "真人授权已过期" : "真人授权未通过";
  const message = succeeded ? "可以关闭此页面并返回繁境继续创作。" : "请返回繁境重新发起授权。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

export default router.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const result = await completePortraitLivenessCallback({
      callbackNonce: callbackValue(req.query.state, 256),
      bytedToken: callbackValue(req.query.bytedToken ?? req.query.BytedToken, 4_096),
      resultCode: callbackValue(req.query.resultCode ?? req.query.ResultCode, 16),
      algorithmBaseRespCode: callbackValue(req.query.algorithmBaseRespCode, 64) || null,
      reqMeasureInfoValue: callbackValue(req.query.reqMeasureInfoValue, 64) || null,
      verifyType: callbackValue(req.query.verify_type ?? req.query.verifyType, 64) || null,
    });
    return res.status(result.state === "succeeded" ? 200 : 422).type("html").send(html(result.state));
  } catch (caught) {
    const status = caught instanceof PortraitProviderRuntimeError ? caught.status : 503;
    // Never reflect callback query values or provider text into the response.
    return res.status(status).type("html").send(html("failed"));
  }
});
