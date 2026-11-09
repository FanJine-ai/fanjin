import { AGENT_ROLES, type AgentRole } from "@/agent-runtime/contracts";
import type { AgentRoleRuntimeConfig } from "@/agent-runtime/agentRuntimeConfigService";
import {
  AGENT_MODEL_PROFILE_REGISTRY,
  AGENT_PROMPT_REGISTRY,
  AGENT_SKILL_REGISTRY,
} from "@/agent-runtime/runtimeConfigRegistry";

export interface AgentRuntimeConfigRefDto {
  key: string;
  version: string;
}

export interface AgentRoleRuntimeConfigDto {
  role: AgentRole;
  promptRef: AgentRuntimeConfigRefDto;
  skillRefs: AgentRuntimeConfigRefDto[];
  modelProfileRef: AgentRuntimeConfigRefDto;
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

export function toAgentRoleRuntimeConfigDto(
  config: AgentRoleRuntimeConfig,
): AgentRoleRuntimeConfigDto {
  return {
    role: config.role,
    promptRef: { key: config.promptKey, version: config.promptVersion },
    skillRefs: config.skillRefs.map((ref) => ({ key: ref.key, version: ref.version })),
    modelProfileRef: {
      key: config.modelProfileKey,
      version: config.modelProfileVersion,
    },
    modelAliasOverride: config.modelAliasOverride,
    resolvedModelAlias: config.resolvedModelAlias,
    temperatureMilli: config.temperatureMilli,
    maxOutputTokens: config.maxOutputTokens,
    enabled: config.enabled,
    revision: config.revision,
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt,
    source: config.source,
  };
}

/**
 * Admin-safe Registry metadata. Deliberately enumerate every returned field:
 * Prompt/Skill content, content hashes, legacy migration source paths, provider
 * configuration and credentials are not part of this DTO.
 */
export function agentRuntimeConfigRegistryDto(role?: AgentRole) {
  return {
    roles: [...AGENT_ROLES],
    prompts: AGENT_PROMPT_REGISTRY
      .filter((item) => role === undefined || item.role === role)
      .map((item) => ({
        key: item.key,
        version: item.version,
        role: item.role,
      })),
    skills: AGENT_SKILL_REGISTRY
      .filter((item) => role === undefined || item.roles.includes(role))
      .map((item) => ({
        key: item.key,
        version: item.version,
        displayName: item.displayName,
        roles: [...item.roles],
      })),
    modelProfiles: AGENT_MODEL_PROFILE_REGISTRY.map((item) => ({
      key: item.key,
      version: item.version,
      modelAlias: item.modelAlias,
      temperatureMilli: item.temperatureMilli,
      maxOutputTokens: item.maxOutputTokens,
      capabilities: [...item.capabilities],
    })),
  };
}
