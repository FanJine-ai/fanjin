export type PlatformSettingType = "string" | "textarea" | "number" | "boolean" | "select" | "secret";
export type PlatformSettingValue = string | number | boolean;
export interface PlatformSettingSection { id: string; title: string; description: string; }
export interface PlatformSettingDefinition { key: string; section: string; label: string; description: string; type: PlatformSettingType; defaultValue: PlatformSettingValue; options?: Array<{ label: string; value: string }>; min?: number; max?: number; step?: number; suffix?: string; restartRequired?: boolean; secret?: boolean; }
export interface PlatformSettingItem extends PlatformSettingDefinition { value: PlatformSettingValue; configured?: boolean; }
export interface PlatformSettingsPayload { sections: PlatformSettingSection[]; definitions: PlatformSettingDefinition[]; items: PlatformSettingItem[]; settings: Record<string, PlatformSettingValue>; }

export function isSecretSetting(item: PlatformSettingDefinition) {
  return Boolean(item.secret || item.type === "secret");
}

export function isCustomizedSetting(item: PlatformSettingItem) {
  if (isSecretSetting(item)) return Boolean(item.configured);
  return item.value !== item.defaultValue;
}

export function formatSettingValue(
  item: PlatformSettingDefinition,
  value: PlatformSettingValue,
) {
  if (item.type === "boolean") return value ? "已开启" : "已关闭";
  if (item.type === "select") {
    return item.options?.find((option) => option.value === String(value))?.label || String(value);
  }
  const text = String(value ?? "").trim();
  if (!text) return "空值";
  return item.suffix ? `${text} ${item.suffix}` : text;
}

export function emptySettingsPayload(): PlatformSettingsPayload { return { sections: [], definitions: [], items: [], settings: {} }; }
export function normalizeSettingsPayload(value: unknown): PlatformSettingsPayload {
  const data = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  const object = data && typeof data === "object" ? data as Partial<PlatformSettingsPayload> : {};
  const definitions = Array.isArray(object.definitions) ? object.definitions : [];
  const settings = object.settings && typeof object.settings === "object" ? object.settings : {};
  const items = Array.isArray(object.items) ? object.items : definitions.map((definition) => ({ ...definition, value: settings[definition.key] ?? definition.defaultValue, configured: Object.prototype.hasOwnProperty.call(settings, definition.key) }));
  return { sections: Array.isArray(object.sections) ? object.sections : [], definitions, items, settings };
}
