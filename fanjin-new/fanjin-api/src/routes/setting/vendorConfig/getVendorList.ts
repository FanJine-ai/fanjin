import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { redactProviderChannelConfig } from "@/lib/providerChannelSecrets";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const data = await u.db("o_vendorConfig").select("*");

  const list = (
    await Promise.all(
      data.map(async (item) => {
        const vendor = u.vendor.getVendor(item.id!);
        if (!vendor) {
          await u.db("o_vendorConfig").where("id", item.id).delete();
          return null
        };
        return {
          ...item,
          inputValues: redactProviderChannelConfig(JSON.parse(item.inputValues ?? "{}")),
          models: await u.vendor.getModelList(item.id!),
          code: u.vendor.getCode(item.id!),
          description: vendor.description ?? "",
          inputs: vendor.inputs,
          author: vendor.author,
          name: vendor.name,
          version: vendor.version ?? "1.0",
        };
      }),
    )
  ).filter((i) => Boolean(i));

  const priority = (id: string | undefined) => id === "fanjin-official" ? 0 : id === "fanjin" ? 1 : 2;
  list.sort((a, b) => priority(a!.id) - priority(b!.id));
  res.status(200).send(success(list));
});
