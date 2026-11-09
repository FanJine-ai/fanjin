import { z } from "zod";
import { relayEndpointTypes, relayScopes } from "@/lib/relay";

export const logicalPriceSchema = z.object({
  unit: z.string().trim().min(1),
  unitPriceMicros: z.number().int().min(0),
  currency: z.literal("GU").default("GU"),
  ruleConfig: z.record(z.string(), z.any()).default({}),
}).strict();

export const modelRouteGroupDraftSchema = z.object({
  existingGroupKey: z.string().trim().optional().nullable(),
  scope: z.enum(relayScopes),
  workspaceId: z.string().trim().optional().nullable(),
  endpointType: z.enum(relayEndpointTypes),
  publicModel: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(200).optional().nullable(),
  disabled: z.boolean().default(true),
  targets: z.array(z.object({
    id: z.string().trim().optional().nullable(),
    channelId: z.string().trim().min(1),
    upstreamModel: z.string().trim().min(1).max(500),
    tier: z.enum(["P0", "P1", "P2"]),
    trafficWeight: z.number().int().min(1).max(1000),
    routeRecipe: z.record(z.string(), z.any()).optional(),
  }).strict()).min(1).max(20),
  pricing: logicalPriceSchema.optional().nullable(),
}).strict();
