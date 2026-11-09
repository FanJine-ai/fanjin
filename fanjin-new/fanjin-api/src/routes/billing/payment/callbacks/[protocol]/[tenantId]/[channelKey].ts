import express from "express";

import { runtimeCommercialTenantById } from "@/lib/commercialTenant";
import { applyVerifiedProviderCallback, onlinePaymentErrorResponse } from "@/lib/onlinePayment";
import { verifyAlipayCallback, verifyWechatCallback } from "@/lib/onlinePaymentGateway";
import { configuredOnlinePaymentChannel, normalizePaymentProtocol } from "@/lib/tenantPaymentConfig";
import { db } from "@/utils/db";

const router = express.Router({ mergeParams: true });

export default router.post("/", async (req, res) => {
  const params = req.params as any;
  const protocol = String(params.protocol || "");
  try {
    const tenant = await runtimeCommercialTenantById(db, params.tenantId);
    const channel = await configuredOnlinePaymentChannel(tenant, params.channelKey);
    if (normalizePaymentProtocol(channel) !== protocol) {
      return res.status(404).send({ message: "支付回调渠道不存在" });
    }
    const rawBody = String((req as any).rawPaymentCallbackBody || "");
    if (!rawBody) return res.status(400).send({ message: "支付回调正文为空" });
    const evidence = protocol === "wechat_v3"
      ? verifyWechatCallback(channel, req.headers, rawBody)
      : verifyAlipayCallback(channel, rawBody);
    await applyVerifiedProviderCallback({
      tenantId: tenant.id,
      channelKey: String(params.channelKey),
      evidence,
    });
    if (protocol === "alipay") return res.status(200).type("text/plain").send("success");
    return res.status(200).send({ code: "SUCCESS", message: "成功" });
  } catch (error) {
    const known = onlinePaymentErrorResponse(error);
    if (protocol === "alipay") return res.status(known?.status || 500).type("text/plain").send("failure");
    if (known) return res.status(known.status).send(known.body);
    throw error;
  }
});
