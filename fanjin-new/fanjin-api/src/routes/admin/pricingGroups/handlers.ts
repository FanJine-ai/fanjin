import type { Response } from "express";
import { PricingGroupError } from "@/lib/pricingGroups";

export function sendPricingGroupError(res: Response, caught: unknown): Response | null {
  if (!(caught instanceof PricingGroupError)) return null;
  return res.status(caught.statusCode).send({ message: caught.message, code: caught.code });
}
