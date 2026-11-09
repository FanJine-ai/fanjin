import { z } from "zod";
import { readRequestSchema } from "@/middleware/middleware";
import type { StudioOperation } from "./studioCatalog";

const cache = new Map<string, Promise<z.ZodObject>>();
/** Descriptions and runtime parsing share the web route's actual validator. */
export function studioInputSchema(op: StudioOperation): Promise<z.ZodObject> {

  let pending = cache.get(op.name);
  if (!pending) {
    pending = op.load().then(async ({ default: router }) => {
      const route = router.stack.find((layer: any) => layer.route?.path === op.path && layer.route.methods[op.method.toLowerCase()])?.route;
      if (!route) throw new Error(`Missing registered route for ${op.name}`);
      if (!op.routeSchema && !op.schemaLoader) return op.schema;
      const fields: Record<string, z.ZodType> = op.schemaLoader ? { ...(await op.schemaLoader()).shape } : {};
      for (const layer of route.stack) {
        const validator = readRequestSchema(layer.handle);
        if (validator) Object.assign(fields, validator.schema.shape);
      }
      if (!Object.keys(fields).length) throw new Error(`Missing shared request schema for ${op.name}`);
      op.bodyIdempotency = Boolean(fields.idempotencyKey);
      return z.strictObject({ ...op.schema.shape, ...fields });
    }).catch(error => { cache.delete(op.name); throw error; });
    cache.set(op.name, pending);
  }
  return pending;
}
