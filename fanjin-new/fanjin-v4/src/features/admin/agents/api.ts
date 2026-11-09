import { ApiError } from "../../../api/http";
import { getAgentRoleConfigs, listAgentSkills } from "../../agent-runtime/api";
import { AGENT_RUNTIME_ROLES } from "../../agent-runtime/types";
import type {
  AgentModelProfileRecord,
  AgentRole,
  AgentRoleConfigRecord,
  AgentSkillRecord,
  AgentConfigLoadState,
} from "./types";

const INVALID_RESPONSE_MESSAGE = "Agent 运行时配置响应格式无效";
const INVALID_RESPONSE_CODE = "agent_runtime_config_invalid";

const TRANSPORT_KEYS = ["configs", "registry", "runtime"] as const;
const REGISTRY_KEYS = ["roles", "prompts", "skills", "modelProfiles"] as const;
const CONFIG_KEYS = [
  "role",
  "promptRef",
  "skillRefs",
  "modelProfileRef",
  "modelAliasOverride",
  "resolvedModelAlias",
  "temperatureMilli",
  "maxOutputTokens",
  "enabled",
  "revision",
  "updatedBy",
  "updatedAt",
  "source",
] as const;
const CONFIG_REF_KEYS = ["key", "version"] as const;
const PROMPT_KEYS = ["key", "version", "role"] as const;
const SKILL_KEYS = ["key", "version", "displayName", "roles"] as const;
const PUBLIC_SKILL_KEYS = [...SKILL_KEYS, "billingPolicy"] as const;
const PUBLIC_SKILL_METADATA_KEYS = [
  "category", "summary", "useCases", "input", "output", "limits", "example",
  "publisher", "provenance", "copyMode", "description", "source", "sourceId", "sourceAuthor", "tags",
] as const;
const SKILL_BILLING_POLICY_KEYS = [
  "currency",
  "catalogAccessMicros",
  "templateCopyMicros",
  "executionMode",
  "surchargeMicros",
] as const;
const MODEL_PROFILE_KEYS = [
  "key",
  "version",
  "modelAlias",
  "temperatureMilli",
  "maxOutputTokens",
  "capabilities",
] as const;
const SKILLS_RESPONSE_KEYS = ["skills"] as const;

const VALID_ROLES = new Set<string>(AGENT_RUNTIME_ROLES);
const VALID_SOURCES = new Set(["registry", "database"]);
const VALID_MODEL_CAPABILITIES = new Set([
  "creative-writing",
  "long-context",
  "reasoning",
  "review",
  "structured-output",
  "tools",
  "vision",
]);

const MAX_DEPTH = 16;
const MAX_NODE_COUNT = 50_000;
const MAX_OBJECT_KEYS = 200;
const MAX_ARRAY_LENGTH = 5_000;
const MAX_STRING_LENGTH = 10_000;
const MAX_REFERENCE_LENGTH = 200;
const MAX_SKILL_REFS = 50;
const MAX_REGISTRY_ITEMS = 1_000;
const MAX_CAPABILITIES = 50;
const MIN_TEMPERATURE_MILLI = 0;
const MAX_TEMPERATURE_MILLI = 2_000;
const MIN_OUTPUT_TOKENS = 1;
const MAX_OUTPUT_TOKENS = 262_144;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

let transportInflight: Promise<unknown> | null = null;

function invalidAgentConfigResponse(): never {
  throw new ApiError(INVALID_RESPONSE_MESSAGE, { code: INVALID_RESPONSE_CODE });
}

/**
 * Clone untrusted JSON-like data from one descriptor snapshot per object.
 *
 * The original object is never frozen or read through ordinary property
 * access. Accessors, symbols, prototype tricks, sparse arrays, cycles and
 * shared object identities are rejected before a deeply frozen plain clone is
 * exposed to any schema projector.
 */
function cloneUntrustedPlainData(value: unknown): unknown {
  let nodeCount = 0;
  const seen = new WeakSet<object>();

  const clone = (input: unknown, depth: number): unknown => {
    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT || depth > MAX_DEPTH) {
      invalidAgentConfigResponse();
    }

    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (input.length > MAX_STRING_LENGTH) invalidAgentConfigResponse();
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input) || !Number.isSafeInteger(input)) {
        invalidAgentConfigResponse();
      }
      return input;
    }
    if (typeof input !== "object") invalidAgentConfigResponse();

    if (seen.has(input)) invalidAgentConfigResponse();
    seen.add(input);

    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      invalidAgentConfigResponse();
    }

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.some((key) => typeof key === "symbol")) {
      invalidAgentConfigResponse();
    }
    const stringKeys = descriptorKeys as string[];

    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_ARRAY_LENGTH
      ) {
        invalidAgentConfigResponse();
      }
      const length = lengthDescriptor.value as number;
      if (stringKeys.length !== length + 1 || !stringKeys.includes("length")) {
        invalidAgentConfigResponse();
      }

      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, "value")
          || descriptor.enumerable !== true
        ) {
          invalidAgentConfigResponse();
        }
        output.push(clone(descriptor.value, depth + 1));
      }
      return Object.freeze(output);
    }

    if (stringKeys.length > MAX_OBJECT_KEYS) invalidAgentConfigResponse();
    const output: Record<string, unknown> = {};
    for (const key of stringKeys) {
      if (key.length > MAX_STRING_LENGTH) invalidAgentConfigResponse();
      const descriptor = descriptors[key];
      if (
        !descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || descriptor.enumerable !== true
      ) {
        invalidAgentConfigResponse();
      }
      Object.defineProperty(output, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(output);
  };

  try {
    return clone(value, 0);
  } catch {
    invalidAgentConfigResponse();
  }
}

function projectSafely<T>(projector: () => T): T {
  try {
    return projector();
  } catch {
    invalidAgentConfigResponse();
  }
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidAgentConfigResponse();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    allowedKeys.some((key) => !keys.includes(key))
    || keys.some((key) => !allowedKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    invalidAgentConfigResponse();
  }
  return record;
}

function boundedArray(value: unknown, maximum = MAX_REGISTRY_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalidAgentConfigResponse();
  }
  return value;
}

function canonicalString(value: unknown, maximum = MAX_REFERENCE_LENGTH): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
  ) {
    invalidAgentConfigResponse();
  }
  return value;
}

function canonicalNullableString(value: unknown): string | null {
  if (value === null) return null;
  return canonicalString(value);
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    invalidAgentConfigResponse();
  }
  return value;
}

function nullableIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  return integerInRange(value, minimum, maximum);
}

function canonicalRole(value: unknown): AgentRole {
  if (typeof value !== "string" || !VALID_ROLES.has(value)) {
    invalidAgentConfigResponse();
  }
  return value as AgentRole;
}

function uniqueIdentity(key: string, version: string): string {
  return JSON.stringify([key, version]);
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalidAgentConfigResponse();
}

function validateConfigRef(value: unknown): { key: string; version: string } {
  const ref = exactRecord(value, CONFIG_REF_KEYS);
  return {
    key: canonicalString(ref.key),
    version: canonicalString(ref.version),
  };
}

function validateCanonicalRoleList(value: unknown): AgentRole[] {
  const roles = boundedArray(value, AGENT_RUNTIME_ROLES.length).map(canonicalRole);
  if (
    roles.length !== AGENT_RUNTIME_ROLES.length
    || roles.some((role, index) => role !== AGENT_RUNTIME_ROLES[index])
  ) {
    invalidAgentConfigResponse();
  }
  return roles;
}

function validatePrompt(value: unknown): {
  key: string;
  version: string;
  role: AgentRole;
} {
  const prompt = exactRecord(value, PROMPT_KEYS);
  return {
    key: canonicalString(prompt.key),
    version: canonicalString(prompt.version),
    role: canonicalRole(prompt.role),
  };
}

function validateSkill(value: unknown, publicCatalog = false): AgentSkillRecord {
  const skill = exactRecord(value, publicCatalog ? PUBLIC_SKILL_KEYS : SKILL_KEYS,
    publicCatalog ? PUBLIC_SKILL_METADATA_KEYS : []);
  const roles = boundedArray(skill.roles, AGENT_RUNTIME_ROLES.length).map(canonicalRole);
  if (roles.length === 0) invalidAgentConfigResponse();
  assertUnique(roles);
  canonicalString(skill.key);
  canonicalString(skill.version);
  canonicalString(skill.displayName);
  if (publicCatalog) {
    for (const key of PUBLIC_SKILL_METADATA_KEYS) {
      if (!(key in skill)) continue;
      if (["useCases", "limits", "tags"].includes(key)) {
        boundedArray(skill[key]).forEach((entry) => canonicalString(entry, MAX_STRING_LENGTH));
      } else if (["sourceId", "sourceAuthor"].includes(key) && skill[key] === null) {
        continue;
      } else {
        canonicalString(skill[key], MAX_STRING_LENGTH);
      }
    }
    const policy = exactRecord(skill.billingPolicy, SKILL_BILLING_POLICY_KEYS);
    if (policy.currency !== "GU" || policy.executionMode !== "underlying_usage") {
      invalidAgentConfigResponse();
    }
    integerInRange(policy.catalogAccessMicros, 0, Number.MAX_SAFE_INTEGER);
    integerInRange(policy.templateCopyMicros, 0, Number.MAX_SAFE_INTEGER);
    integerInRange(policy.surchargeMicros, 0, Number.MAX_SAFE_INTEGER);
  }
  return skill as AgentSkillRecord;
}

function validateModelProfile(
  value: unknown,
  validateCapabilities: boolean,
): AgentModelProfileRecord {
  const profile = exactRecord(value, MODEL_PROFILE_KEYS);
  canonicalString(profile.key);
  canonicalString(profile.version);
  canonicalString(profile.modelAlias);
  integerInRange(profile.temperatureMilli, MIN_TEMPERATURE_MILLI, MAX_TEMPERATURE_MILLI);
  integerInRange(profile.maxOutputTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

  if (validateCapabilities) {
    const capabilities = boundedArray(profile.capabilities, MAX_CAPABILITIES)
      .map((capability) => canonicalString(capability));
    if (
      capabilities.length === 0
      || capabilities.some((capability) => !VALID_MODEL_CAPABILITIES.has(capability))
    ) {
      invalidAgentConfigResponse();
    }
    assertUnique(capabilities);
  }
  return profile as AgentModelProfileRecord;
}

function validateRoleConfig(value: unknown): AgentRoleConfigRecord {
  const config = exactRecord(value, CONFIG_KEYS);
  canonicalRole(config.role);
  validateConfigRef(config.promptRef);
  const skillRefs = boundedArray(config.skillRefs, MAX_SKILL_REFS).map(validateConfigRef);
  assertUnique(skillRefs.map((ref) => uniqueIdentity(ref.key, ref.version)));
  validateConfigRef(config.modelProfileRef);
  canonicalNullableString(config.modelAliasOverride);
  canonicalString(config.resolvedModelAlias);
  integerInRange(config.temperatureMilli, MIN_TEMPERATURE_MILLI, MAX_TEMPERATURE_MILLI);
  integerInRange(config.maxOutputTokens, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  if (typeof config.enabled !== "boolean") invalidAgentConfigResponse();
  const revision = integerInRange(config.revision, 0, Number.MAX_SAFE_INTEGER);
  const updatedBy = nullableIntegerInRange(config.updatedBy, 1, Number.MAX_SAFE_INTEGER);
  const updatedAt = nullableIntegerInRange(config.updatedAt, 0, Number.MAX_SAFE_INTEGER);
  if (typeof config.source !== "string" || !VALID_SOURCES.has(config.source)) {
    invalidAgentConfigResponse();
  }
  if (
    config.source === "registry"
      ? revision !== 0 || updatedBy !== null || updatedAt !== null || config.modelAliasOverride !== null
      : revision < 1 || updatedBy === null || updatedAt === null
  ) {
    invalidAgentConfigResponse();
  }
  return config as AgentRoleConfigRecord;
}

function transportEnvelope(value: unknown): {
  record: Record<string, unknown>;
  registry: Record<string, unknown>;
} {
  const record = exactRecord(value, TRANSPORT_KEYS);
  return {
    record,
    registry: exactRecord(record.registry, REGISTRY_KEYS),
  };
}

function projectRoleConfigs(value: unknown): AgentRoleConfigRecord[] {
  const { record, registry } = transportEnvelope(value);
  validateCanonicalRoleList(registry.roles);

  const prompts = boundedArray(registry.prompts).map(validatePrompt);
  const promptIdentities = prompts.map((prompt) => uniqueIdentity(prompt.key, prompt.version));
  assertUnique(promptIdentities);
  const promptsByIdentity = new Map(
    prompts.map((prompt) => [uniqueIdentity(prompt.key, prompt.version), prompt] as const),
  );

  const skills = boundedArray(registry.skills).map((skill) => validateSkill(skill));
  const skillIdentities = skills.map((skill) => uniqueIdentity(skill.key, skill.version));
  assertUnique(skillIdentities);
  const skillsByIdentity = new Map(
    skills.map((skill) => [uniqueIdentity(skill.key, skill.version), skill] as const),
  );

  const profiles = boundedArray(registry.modelProfiles)
    .map((profile) => validateModelProfile(profile, false));
  const profileIdentities = profiles.map((profile) => uniqueIdentity(profile.key, profile.version));
  assertUnique(profileIdentities);
  const profilesByIdentity = new Map(
    profiles.map((profile) => [uniqueIdentity(profile.key, profile.version), profile] as const),
  );

  const configs = boundedArray(record.configs, AGENT_RUNTIME_ROLES.length)
    .map(validateRoleConfig);
  if (
    configs.length !== AGENT_RUNTIME_ROLES.length
    || configs.some((config, index) => config.role !== AGENT_RUNTIME_ROLES[index])
  ) {
    invalidAgentConfigResponse();
  }

  for (const config of configs) {
    const prompt = promptsByIdentity.get(
      uniqueIdentity(config.promptRef.key, config.promptRef.version),
    );
    if (!prompt || prompt.role !== config.role) invalidAgentConfigResponse();

    for (const ref of config.skillRefs) {
      const skill = skillsByIdentity.get(uniqueIdentity(ref.key, ref.version));
      if (!skill || !skill.roles.includes(config.role)) invalidAgentConfigResponse();
    }

    const profile = profilesByIdentity.get(
      uniqueIdentity(config.modelProfileRef.key, config.modelProfileRef.version),
    );
    if (!profile) invalidAgentConfigResponse();
    const expectedAlias = config.modelAliasOverride ?? (config.role === "main" ? profile.modelAlias : "agent-main");
    if (config.resolvedModelAlias !== expectedAlias) invalidAgentConfigResponse();
    if (
      config.source === "registry"
      && (
        config.temperatureMilli !== profile.temperatureMilli
        || config.maxOutputTokens !== profile.maxOutputTokens
      )
    ) {
      invalidAgentConfigResponse();
    }
  }

  return record.configs as AgentRoleConfigRecord[];
}

function projectModelProfiles(value: unknown): AgentModelProfileRecord[] {
  const { registry } = transportEnvelope(value);
  const profiles = boundedArray(registry.modelProfiles)
    .map((profile) => validateModelProfile(profile, true));
  assertUnique(profiles.map((profile) => uniqueIdentity(profile.key, profile.version)));
  return registry.modelProfiles as AgentModelProfileRecord[];
}

function projectSkills(value: unknown): AgentSkillRecord[] {
  const response = exactRecord(value, SKILLS_RESPONSE_KEYS);
  const skills = boundedArray(response.skills).map((skill) => validateSkill(skill, true));
  assertUnique(skills.map((skill) => uniqueIdentity(skill.key, skill.version)));
  return response.skills as AgentSkillRecord[];
}

function getTransportSnapshot(): Promise<unknown> {
  if (transportInflight) return transportInflight;

  const pending = Promise.resolve()
    .then(() => getAgentRoleConfigs())
    .catch((error: unknown) => {
      if (error instanceof ApiError) throw error;
      invalidAgentConfigResponse();
    })
    .then(cloneUntrustedPlainData);
  const tracked = pending.finally(() => {
    if (transportInflight === tracked) transportInflight = null;
  });
  transportInflight = tracked;
  return tracked;
}

export async function fetchAgentConfigRoles(): Promise<AgentRoleConfigRecord[]> {
  const snapshot = await getTransportSnapshot();
  return projectSafely(() => projectRoleConfigs(snapshot));
}

export async function fetchAgentModelProfiles(): Promise<AgentModelProfileRecord[]> {
  const snapshot = await getTransportSnapshot();
  return projectSafely(() => projectModelProfiles(snapshot));
}

export async function fetchAgentSkills(): Promise<AgentSkillRecord[]> {
  let raw: unknown;
  try {
    raw = await listAgentSkills();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalidAgentConfigResponse();
  }
  const snapshot = cloneUntrustedPlainData(raw);
  return projectSafely(() => projectSkills(snapshot));
}

export function mapLoadState(error: string | null, loading: boolean): AgentConfigLoadState {
  if (loading) return { loading: true, error: null };
  if (error) return { loading: false, error };
  return { loading: false, error: null };
}

export function _resetTransportCacheForTesting(): void {
  transportInflight = null;
}
