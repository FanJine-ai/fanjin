import express from "express";
import { getRegistrationPolicy } from "@/lib/registrationPolicy";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  return res.status(200).send(success(await getRegistrationPolicy()));
});
