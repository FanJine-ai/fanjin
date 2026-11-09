import type { Knex } from "knex";

export const MODEL_ROUTE_BOOTSTRAP_TOMBSTONES_KEY = "platform.model.bootstrapRouteTombstones";

export interface ModelRouteBootstrapIdentity {
  endpointType: string;
  model: string;
  provider: string;
}

interface StoredTombstone extends ModelRouteBootstrapIdentity {
  deletedAt: number;
}

type TombstoneDocument = {
  version: 1;
  routes: StoredTombstone[];
};

function token(value: unknown): string {
  return String(value ?? "").trim();
}

export function modelRouteBootstrapIdentityKey(identity: ModelRouteBootstrapIdentity): string {
  return [token(identity.endpointType), token(identity.provider), token(identity.model)].join("\u0000");
}

export function isBootstrapManagedModelRoute(routeConfig: unknown): boolean {
  let value = routeConfig;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return config.managedBy === "production-bootstrap" || config.seeded === true;
}

function parseDocument(raw: unknown): TombstoneDocument {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, routes: [] };
    }
    const routes = Array.isArray((parsed as Record<string, unknown>).routes)
      ? (parsed as Record<string, unknown>).routes as unknown[]
      : [];
    return {
      version: 1,
      routes: routes.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const endpointType = token(row.endpointType);
        const model = token(row.model);
        const provider = token(row.provider);
        if (!endpointType || !model || !provider) return [];
        return [{
          endpointType,
          model,
          provider,
          deletedAt: Number(row.deletedAt) || 0,
        }];
      }),
    };
  } catch {
    return { version: 1, routes: [] };
  }
}

export async function readModelRouteBootstrapTombstones(
  database: Knex | Knex.Transaction,
): Promise<Set<string>> {
  if (!(await database.schema.hasTable("o_setting"))) return new Set();
  const row = await database("o_setting")
    .where({ key: MODEL_ROUTE_BOOTSTRAP_TOMBSTONES_KEY })
    .select("value")
    .first();
  return new Set(parseDocument(row?.value).routes.map(modelRouteBootstrapIdentityKey));
}

export async function recordModelRouteBootstrapTombstone(
  database: Knex | Knex.Transaction,
  identity: ModelRouteBootstrapIdentity,
  deletedAt = Date.now(),
): Promise<boolean> {
  if (!(await database.schema.hasTable("o_setting"))) return false;
  const normalized: ModelRouteBootstrapIdentity = {
    endpointType: token(identity.endpointType),
    model: token(identity.model),
    provider: token(identity.provider),
  };
  if (!normalized.endpointType || !normalized.model || !normalized.provider) return false;

  const existing = await database("o_setting")
    .where({ key: MODEL_ROUTE_BOOTSTRAP_TOMBSTONES_KEY })
    .select("value")
    .first();
  const document = parseDocument(existing?.value);
  const identityKey = modelRouteBootstrapIdentityKey(normalized);
  const routes = document.routes.filter((entry) => modelRouteBootstrapIdentityKey(entry) !== identityKey);
  routes.push({ ...normalized, deletedAt });
  const value = JSON.stringify({ version: 1, routes } satisfies TombstoneDocument);

  if (existing) {
    await database("o_setting").where({ key: MODEL_ROUTE_BOOTSTRAP_TOMBSTONES_KEY }).update({ value });
  } else {
    await database("o_setting").insert({ key: MODEL_ROUTE_BOOTSTRAP_TOMBSTONES_KEY, value });
  }
  return true;
}
