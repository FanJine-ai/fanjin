import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import { normalizeSettingsPayload, type PlatformSettingValue } from "./types";
export async function loadPlatformSettings() { return normalizeSettingsPayload(await apiPost<unknown>("/admin/systemSettings/list", {})); }
export async function updatePlatformSettings(settings: Record<string, PlatformSettingValue>) { return apiPostWithStepUp("/admin/systemSettings/update", { settings }, "admin.system_settings"); }
export async function updatePlatformSetting(key: string, value: PlatformSettingValue) { return updatePlatformSettings({ [key]: value }); }
