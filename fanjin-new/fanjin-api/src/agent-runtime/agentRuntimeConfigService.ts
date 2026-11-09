import type { Knex } from "knex";
import { AGENT_ROLES, type AgentRole } from "@/agent-runtime/contracts";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import {
  AGENT_MODEL_PROFILE_REGISTRY,
  AGENT_PROMPT_REGISTRY,
  AGENT_ROLE_CONFIG_REGISTRY,
  AGENT_SKILL_REGISTRY,
  resolveAgentRoleTransportAlias,
} from "@/agent-runtime/runtimeConfigRegistry";
import { AGENT_ROLE_CONFIG_TABLE } from "@/lib/migrations/agentRoleConfig";

export const AGENT_ROLE_CONFIG_MIN_TEMPERATURE_MILLI = 0;
export const AGENT_ROLE_CONFIG_MAX_TEMPERATURE_MILLI = 2_000;
export const AGENT_ROLE_CONFIG_MIN_OUTPUT_TOKENS = 1;
export const AGENT_ROLE_CONFIG_MAX_OUTPUT_TOKENS = 262_144;

export interface AgentRuntimeConfigReference {
  key: string;
  version: string;
}

export interface AgentRoleRuntimeConfig {
  role: AgentRole;
  promptKey: string;
  promptVersion: string;
  skillRefs: AgentRuntimeConfigReference[];
  modelProfileKey: string;
  modelProfileVersion: string;
  modelAliasOverride: string | null;
  resolvedModelAlias: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
  revision: number;
  updatedBy: number | null;
  updatedAt: number | null;
  source: "registry" | "database";
}

export interface SaveAgentRoleRuntimeConfigInput {
  role: AgentRole;
  promptKey: string;
  promptVersion: string;
  skillRefs: readonly AgentRuntimeConfigReference[];
  modelProfileKey: string;
  modelProfileVersion: string;
  modelAliasOverride?: string | null;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
  expectedRevision: number;
  updatedBy: number;
}

interface NormalizedConfigValues {
  role: AgentRole;
  promptKey: string;
  promptVersion: string;
  skillRefs: AgentRuntimeConfigReference[];
  modelProfileKey: string;
  modelProfileVersion: string;
  modelAliasOverride: string | null;
  resolvedModelAlias: string;
  temperatureMilli: number;
  maxOutputTokens: number;
  enabled: boolean;
}

interface RawAgentRoleConfigRow {
  role: unknown;
  promptKey: unknown;
  promptVersion: unknown;
  skillRefs: unknown;
  modelProfileKey: unknown;
  modelProfileVersion: unknown;
  modelAliasOverride: unknown;
  temperatureMilli: unknown;
  maxOutputTokens: unknown;
  enabled: unknown;
  revision: unknown;
  updatedBy: unknown;
  updatedAt: unknown;
}

export interface AgentRuntimeConfigServiceOptions {
  clock?: () => number;
}

function cleanReferencePart(value: unknown, field: string, status: number): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200) {
    throw new AgentRuntimeError(status, "agent_config_reference_invalid", `${field} 必填且不能超过 200 字符`);
  }
  return text;
}

function normalizeRole(value: unknown, status: number): AgentRole {
  const role = String(value ?? "").trim();
  if (!(AGENT_ROLES as readonly string[]).includes(role)) {
    throw new AgentRuntimeError(status, "agent_role_invalid", `未知 Agent 角色：${role || "(empty)"}`);
  }
  return role as AgentRole;
}

function normalizeSkillRefs(value: unknown, status: number): AgentRuntimeConfigReference[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new AgentRuntimeError(status, "agent_skill_references_invalid", "skillRefs 必须是最多 50 项的数组");
  }
  const refs = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AgentRuntimeError(status, "agent_skill_references_invalid", `skillRefs[${index}] 格式无效`);
    }
    const record = item as Record<string, unknown>;
    return {
      key: cleanReferencePart(record.key, `skillRefs[${index}].key`, status),
      version: cleanReferencePart(record.version, `skillRefs[${index}].version`, status),
    };
  });
  const identities = refs.map((ref) => `${ref.key}@${ref.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new AgentRuntimeError(status, "agent_skill_reference_duplicate", "skillRefs 不能包含重复版本引用");
  }
  return refs;
}

function normalizeModelAliasOverride(value: unknown, status: number): string | null {
  if (value == null) return null;
  const alias = String(value).trim();
  if (!alias) return null;
  if (alias.length > 200 || /[\u0000-\u001f\u007f]/.test(alias)) {
    throw new AgentRuntimeError(status, "agent_model_alias_override_invalid", "modelAliasOverride 格式无效");
  }
  return alias;
}

function normalizeIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  code: string,
  field: string,
  status: number,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AgentRuntimeError(status, code, `${field} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function normalizeEnabled(value: unknown, status: number): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new AgentRuntimeError(status, "agent_config_enabled_invalid", "enabled 必须是布尔值");
}

function normalizeConfigValues(
  input: {
    role: unknown;
    promptKey: unknown;
    promptVersion: unknown;
    skillRefs: unknown;
    modelProfileKey: unknown;
    modelProfileVersion: unknown;
    modelAliasOverride?: unknown;
    temperatureMilli: unknown;
    maxOutputTokens: unknown;
    enabled: unknown;
  },
  status: number,
): NormalizedConfigValues {
  const role = normalizeRole(input.role, status);
  const promptKey = cleanReferencePart(input.promptKey, "promptKey", status);
  const promptVersion = cleanReferencePart(input.promptVersion, "promptVersion", status);
  const prompt = AGENT_PROMPT_REGISTRY.find(
    (item) => item.key === promptKey && item.version === promptVersion,
  );
  if (!prompt) {
    throw new AgentRuntimeError(status, "agent_prompt_reference_invalid", "Prompt 版本引用不存在");
  }
  if (prompt.role !== role) {
    throw new AgentRuntimeError(status, "agent_prompt_role_mismatch", `Prompt 不适用于角色 ${role}`);
  }

  const skillRefs = normalizeSkillRefs(input.skillRefs, status);
  for (const ref of skillRefs) {
    const skill = AGENT_SKILL_REGISTRY.find(
      (item) => item.key === ref.key && item.version === ref.version,
    );
    if (!skill) {
      throw new AgentRuntimeError(status, "agent_skill_reference_invalid", `Skill ${ref.key}@${ref.version} 不存在`);
    }
    if (!skill.roles.includes(role)) {
      throw new AgentRuntimeError(status, "agent_skill_role_mismatch", `Skill ${ref.key}@${ref.version} 不适用于角色 ${role}`);
    }
  }

  const modelProfileKey = cleanReferencePart(input.modelProfileKey, "modelProfileKey", status);
  const modelProfileVersion = cleanReferencePart(input.modelProfileVersion, "modelProfileVersion", status);
  const modelProfile = AGENT_MODEL_PROFILE_REGISTRY.find(
    (item) => item.key === modelProfileKey && item.version === modelProfileVersion,
  );
  if (!modelProfile) {
    throw new AgentRuntimeError(status, "agent_model_profile_reference_invalid", "Model Profile 版本引用不存在");
  }

  const modelAliasOverride = normalizeModelAliasOverride(input.modelAliasOverride, status);
  return {
    role,
    promptKey,
    promptVersion,
    skillRefs,
    modelProfileKey,
    modelProfileVersion,
    modelAliasOverride,
    resolvedModelAlias: resolveAgentRoleTransportAlias({
      role,
      profileModelAlias: modelProfile.modelAlias,
      explicitModelAlias: modelAliasOverride,
    }),
    temperatureMilli: normalizeIntegerInRange(
      input.temperatureMilli,
      AGENT_ROLE_CONFIG_MIN_TEMPERATURE_MILLI,
      AGENT_ROLE_CONFIG_MAX_TEMPERATURE_MILLI,
      "agent_temperature_milli_invalid",
      "temperatureMilli",
      status,
    ),
    maxOutputTokens: normalizeIntegerInRange(
      input.maxOutputTokens,
      AGENT_ROLE_CONFIG_MIN_OUTPUT_TOKENS,
      AGENT_ROLE_CONFIG_MAX_OUTPUT_TOKENS,
      "agent_max_output_tokens_invalid",
      "maxOutputTokens",
      status,
    ),
    enabled: normalizeEnabled(input.enabled, status),
  };
}

function parseStoredSkillRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw new AgentRuntimeError(500, "agent_role_config_corrupt", "持久化 Agent 配置的 skillRefs 无效");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentRuntimeError(500, "agent_role_config_corrupt", "持久化 Agent 配置的 skillRefs 无法解析");
  }
}

function affectedRows(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.length;
  return Number(value || 0);
}

function isUniqueConstraintError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "23505"
    || candidate?.code === "SQLITE_CONSTRAINT"
    || candidate?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || /unique constraint|duplicate key/i.test(String(candidate?.message || ""));
}

function revisionConflict(expectedRevision: number, currentRevision?: number): AgentRuntimeError {
  return new AgentRuntimeError(
    409,
    "agent_config_revision_conflict",
    "Agent 角色配置已被其他请求更新，请重新读取后再保存",
    {
      expectedRevision,
      ...(currentRevision === undefined ? {} : { currentRevision }),
    },
  );
}

export class AgentRuntimeConfigService {
  private readonly clock: () => number;

  constructor(
    private readonly database: Knex,
    options: AgentRuntimeConfigServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  async getRoleConfig(roleValue: AgentRole): Promise<AgentRoleRuntimeConfig> {
    const role = normalizeRole(roleValue, 400);
    const row = await this.database<RawAgentRoleConfigRow>(AGENT_ROLE_CONFIG_TABLE).where({ role }).first();
    if (!row) return this.registryDefault(role);
    return this.mapStoredRow(row);
  }

  async saveRoleConfig(input: SaveAgentRoleRuntimeConfigInput): Promise<AgentRoleRuntimeConfig> {
    const normalized = normalizeConfigValues(input, 400);
    const expectedRevision = normalizeIntegerInRange(
      input.expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      "agent_config_revision_invalid",
      "expectedRevision",
      400,
    );
    const updatedBy = normalizeIntegerInRange(
      input.updatedBy,
      1,
      Number.MAX_SAFE_INTEGER,
      "agent_config_updated_by_invalid",
      "updatedBy",
      400,
    );
    const updatedAt = normalizeIntegerInRange(
      this.clock(),
      0,
      Number.MAX_SAFE_INTEGER,
      "agent_config_clock_invalid",
      "updatedAt",
      500,
    );
    const nextRevision = expectedRevision + 1;
    const row = {
      role: normalized.role,
      promptKey: normalized.promptKey,
      promptVersion: normalized.promptVersion,
      skillRefs: JSON.stringify(normalized.skillRefs),
      modelProfileKey: normalized.modelProfileKey,
      modelProfileVersion: normalized.modelProfileVersion,
      modelAliasOverride: normalized.modelAliasOverride,
      temperatureMilli: normalized.temperatureMilli,
      maxOutputTokens: normalized.maxOutputTokens,
      enabled: normalized.enabled,
      revision: nextRevision,
      updatedBy,
      updatedAt,
    };

    return this.database.transaction(async (trx) => {
      if (expectedRevision === 0) {
        const existing = await trx<RawAgentRoleConfigRow>(AGENT_ROLE_CONFIG_TABLE)
          .where({ role: normalized.role })
          .select("revision")
          .first();
        if (existing) throw revisionConflict(expectedRevision, Number(existing.revision));
        try {
          await trx(AGENT_ROLE_CONFIG_TABLE).insert(row);
        } catch (error) {
          if (isUniqueConstraintError(error)) throw revisionConflict(expectedRevision);
          throw error;
        }
      } else {
        const updated = await trx(AGENT_ROLE_CONFIG_TABLE)
          .where({ role: normalized.role, revision: expectedRevision })
          .update(row);
        if (affectedRows(updated) !== 1) {
          const current = await trx<RawAgentRoleConfigRow>(AGENT_ROLE_CONFIG_TABLE)
            .where({ role: normalized.role })
            .select("revision")
            .first();
          throw revisionConflict(expectedRevision, current ? Number(current.revision) : 0);
        }
      }

      const stored = await trx<RawAgentRoleConfigRow>(AGENT_ROLE_CONFIG_TABLE)
        .where({ role: normalized.role })
        .first();
      if (!stored) {
        throw new AgentRuntimeError(500, "agent_role_config_save_missing", "Agent 角色配置保存后无法读取");
      }
      return this.mapStoredRow(stored);
    });
  }

  private registryDefault(role: AgentRole): AgentRoleRuntimeConfig {
    const config = AGENT_ROLE_CONFIG_REGISTRY.find((item) => item.role === role);
    if (!config) {
      throw new AgentRuntimeError(500, "agent_role_config_missing", `Agent 角色 ${role} 缺少静态默认配置`);
    }
    const modelProfile = AGENT_MODEL_PROFILE_REGISTRY.find(
      (item) => item.key === config.modelProfile.key && item.version === config.modelProfile.version,
    );
    if (!modelProfile) {
      throw new AgentRuntimeError(500, "agent_role_config_invalid", `Agent 角色 ${role} 的默认 Model Profile 无效`);
    }
    const normalized = normalizeConfigValues({
      role,
      promptKey: config.prompt.key,
      promptVersion: config.prompt.version,
      skillRefs: config.skills,
      modelProfileKey: config.modelProfile.key,
      modelProfileVersion: config.modelProfile.version,
      modelAliasOverride: null,
      temperatureMilli: modelProfile.temperatureMilli,
      maxOutputTokens: modelProfile.maxOutputTokens,
      enabled: true,
    }, 500);
    return {
      ...normalized,
      revision: 0,
      updatedBy: null,
      updatedAt: null,
      source: "registry",
    };
  }

  private mapStoredRow(row: RawAgentRoleConfigRow): AgentRoleRuntimeConfig {
    const normalized = normalizeConfigValues({
      ...row,
      skillRefs: parseStoredSkillRefs(row.skillRefs),
    }, 500);
    const revision = normalizeIntegerInRange(
      row.revision,
      1,
      Number.MAX_SAFE_INTEGER,
      "agent_role_config_corrupt",
      "revision",
      500,
    );
    const updatedBy = normalizeIntegerInRange(
      row.updatedBy,
      1,
      Number.MAX_SAFE_INTEGER,
      "agent_role_config_corrupt",
      "updatedBy",
      500,
    );
    const updatedAt = normalizeIntegerInRange(
      row.updatedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      "agent_role_config_corrupt",
      "updatedAt",
      500,
    );
    return {
      ...normalized,
      revision,
      updatedBy,
      updatedAt,
      source: "database",
    };
  }
}
