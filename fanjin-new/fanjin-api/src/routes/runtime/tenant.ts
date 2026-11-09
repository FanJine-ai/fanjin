import express from "express";

import {
  publicCommercialTenantRuntime,
  readCommercialTenantLegalProfile,
  requestCommercialTenant,
} from "@/lib/commercialTenant";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const tenant = requestCommercialTenant(req);
  const legalProfile = await readCommercialTenantLegalProfile(tenant);
  return res.status(200).send(success(publicCommercialTenantRuntime(tenant, legalProfile)));
});
