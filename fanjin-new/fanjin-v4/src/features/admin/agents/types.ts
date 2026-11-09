import type {
  AgentRoleRuntimeConfig,
  AgentRuntimeModelProfileRegistryItem,
  AgentRuntimeRole,
  AgentSkillCatalogItem,
} from "../../agent-runtime/types";

export type AgentRole = AgentRuntimeRole;
export type AgentRoleConfigRecord = AgentRoleRuntimeConfig;
export type AgentSkillRecord = AgentSkillCatalogItem;
export type AgentModelProfileRecord = AgentRuntimeModelProfileRegistryItem;

export type AgentConfigLoadState =
  | { loading: true; error: null }
  | { loading: false; error: string }
  | { loading: false; error: null };
