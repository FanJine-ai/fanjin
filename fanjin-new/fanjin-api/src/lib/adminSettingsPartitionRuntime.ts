import type { Knex } from "knex";
import { db } from "@/utils/db";
import {
  PLATFORM_SETTING_DEFINITIONS,
  PLATFORM_SETTING_SECTIONS,
  PlatformSettingValidationError,
  readPlatformSettings,
  updatePlatformSettings,
  type PlatformSettingDefinition,
  type PlatformSettingItem,
  type PlatformSettingValue,
} from "@/lib/platformSettings";
import {
  assertGenericAdminSettingKeys,
  isGenericAdminSettingKey,
} from "@/lib/adminSettingsPartition";

export const GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS =
  PLATFORM_SETTING_DEFINITIONS.filter((definition) => (
    isGenericAdminSettingKey(definition.key)
  ));

const genericAdminSectionIds = new Set(
  GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS.map((definition) => definition.section),
);

export const GENERIC_ADMIN_PLATFORM_SETTING_SECTIONS =
  PLATFORM_SETTING_SECTIONS.filter((section) => genericAdminSectionIds.has(section.id));

export async function readGenericAdminPlatformSettings(): Promise<{
  settings: Record<string, PlatformSettingValue>;
  items: PlatformSettingItem[];
}>;
export async function readGenericAdminPlatformSettings(
  database?: Knex | Knex.Transaction,
): Promise<{
  settings: Record<string, PlatformSettingValue>;
  items: PlatformSettingItem[];
}>;
export async function readGenericAdminPlatformSettings(
  database: Knex | Knex.Transaction = db,
): Promise<{
  settings: Record<string, PlatformSettingValue>;
  items: PlatformSettingItem[];
}> {
  const current = await readPlatformSettings(database);
  const settings = Object.fromEntries(
    Object.entries(current.settings).filter(([key]) => isGenericAdminSettingKey(key)),
  );
  const items = current.items.filter((item) => isGenericAdminSettingKey(item.key));
  return { settings, items };
}

export interface GenericAdminPlatformSettingUpdate {
  settings: Record<string, PlatformSettingValue>;
  changedKeys: string[];
}

export type GenericAdminPlatformSettingAudit = (
  result: GenericAdminPlatformSettingUpdate,
  transaction: Knex.Transaction,
) => Promise<void>;

function hasExpectedSettingValueType(
  definition: PlatformSettingDefinition,
  value: unknown,
): value is PlatformSettingValue {
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === "string";
}

export function assertGenericAdminSettingValues(
  input: Record<string, unknown>,
): void {
  const definitions = new Map(
    GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS.map((definition) => [
      definition.key,
      definition,
    ]),
  );
  for (const [key, value] of Object.entries(input || {})) {
    const definition = definitions.get(key);
    if (!definition) continue;
    if (!hasExpectedSettingValueType(definition, value)) {
      throw new PlatformSettingValidationError(
        `${definition.label} 的值类型无效`,
        "platform_setting_type_invalid",
      );
    }
  }
}

function submittedChangedKeys(
  input: Record<string, unknown>,
  before: Record<string, PlatformSettingValue>,
  after: Record<string, PlatformSettingValue>,
): string[] {
  const definitions = new Map(
    GENERIC_ADMIN_PLATFORM_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
  );
  return Object.keys(input).filter((key) => {
    const definition = definitions.get(key);
    if (!definition) return false;
    if (definition.secret) {
      const value = input[key];
      return value !== undefined && value !== null && String(value).trim() !== "";
    }
    return before[key] !== after[key];
  });
}

export async function updateGenericAdminPlatformSettings(
  input: Record<string, unknown>,
  writeAudit?: GenericAdminPlatformSettingAudit,
): Promise<GenericAdminPlatformSettingUpdate> {
  assertGenericAdminSettingKeys(Object.keys(input || {}));
  assertGenericAdminSettingValues(input);
  return await db.transaction(async (trx) => {
    const before = (await readGenericAdminPlatformSettings(trx)).settings;
    await updatePlatformSettings(input, trx);
    const settings = (await readGenericAdminPlatformSettings(trx)).settings;
    const result = {
      settings,
      changedKeys: submittedChangedKeys(input, before, settings),
    };
    if (writeAudit) await writeAudit(result, trx);
    return result;
  });
}
