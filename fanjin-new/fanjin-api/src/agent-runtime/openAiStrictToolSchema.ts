const DEFAULT_MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 64;

const JSON_SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const ANNOTATION_KEYWORDS = new Set(["title", "description"]);
const COMMON_KEYWORDS = new Set(["type", "enum", "const"]);
const OBJECT_KEYWORDS = new Set(["properties", "required", "additionalProperties"]);
const ARRAY_KEYWORDS = new Set(["items", "minItems", "maxItems"]);
const STRING_KEYWORDS = new Set(["minLength", "maxLength", "pattern", "format"]);
const NUMBER_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const UNION_KEYWORDS = new Set(["anyOf", "oneOf"]);
const STRIPPED_KEYWORDS = new Set(["$schema", "default"]);

const SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

export type OpenAiStrictToolSchemaErrorCode =
  | "openai_tool_schema_invalid"
  | "openai_tool_schema_unsupported"
  | "openai_tool_schema_root_union"
  | "openai_tool_schema_not_strict"
  | "openai_tool_schema_optional_property"
  | "openai_tool_schema_too_deep"
  | "openai_tool_schema_too_large"
  | "openai_tool_schema_limit_invalid"
  | "openai_tool_schema_profile_invalid";

const SAFE_MESSAGES: Readonly<Record<OpenAiStrictToolSchemaErrorCode, string>> = Object.freeze({
  openai_tool_schema_invalid: "工具 Schema 格式无效",
  openai_tool_schema_unsupported: "工具 Schema 包含不受支持的约束",
  openai_tool_schema_root_union: "工具 Schema 根节点必须是 object，不能是联合类型",
  openai_tool_schema_not_strict: "工具 Schema 的 object 必须禁止额外字段",
  openai_tool_schema_optional_property: "工具 Schema 包含可选字段，不能静默转换为 nullable",
  openai_tool_schema_too_deep: "工具 Schema 嵌套层级超过安全上限",
  openai_tool_schema_too_large: "工具 Schema 投影后超过安全大小上限",
  openai_tool_schema_limit_invalid: "工具 Schema 大小上限配置无效",
  openai_tool_schema_profile_invalid: "工具 Schema 兼容配置无效",
});

export class OpenAiStrictToolSchemaError extends Error {
  readonly code: OpenAiStrictToolSchemaErrorCode;

  constructor(code: OpenAiStrictToolSchemaErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "OpenAiStrictToolSchemaError";
    this.code = code;
  }
}

export interface OpenAiStrictToolSchemaProjectionOptions {
  /** UTF-8 bytes after projection and canonical JSON serialization. */
  maxBytes?: number;
  /**
   * `portable` retains the strict object/type/enum/union contract while
   * removing scalar and collection constraints rejected by some otherwise
   * OpenAI-compatible structured-tool providers. The authoritative Zod
   * schema is still enforced by the Gateway before any tool executes.
   */
  profile?: "native" | "portable";
}

const PORTABLE_STRIPPED_CONSTRAINTS = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

function fail(code: OpenAiStrictToolSchemaErrorCode): never {
  throw new OpenAiStrictToolSchemaError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject accessors, symbols and values that JSON serialization would silently omit. */
function assertDataRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("openai_tool_schema_invalid");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("openai_tool_schema_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("openai_tool_schema_invalid");
    }
  }
}

function assertDenseArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) fail("openai_tool_schema_invalid");
  const ownKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (ownKeys.some((key) => typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key))) {
    fail("openai_tool_schema_invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail("openai_tool_schema_invalid");
  }
}

function isJsonScalar(value: unknown): value is null | string | number | boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function scalarType(value: null | string | number | boolean): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeAllowsValue(type: string, value: null | string | number | boolean): boolean {
  const actual = scalarType(value);
  return type === actual || (type === "number" && actual === "integer");
}

function scalarKey(value: null | string | number | boolean): string {
  return JSON.stringify(value);
}

function projectEnum(value: unknown, type: string | null): Array<null | string | number | boolean> {
  assertDenseArray(value);
  if (value.length === 0) fail("openai_tool_schema_invalid");
  const projected: Array<null | string | number | boolean> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isJsonScalar(item)) fail("openai_tool_schema_unsupported");
    if (type && !typeAllowsValue(type, item)) fail("openai_tool_schema_invalid");
    const key = scalarKey(item);
    if (seen.has(key)) fail("openai_tool_schema_invalid");
    seen.add(key);
    projected.push(item);
  }
  return projected;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("openai_tool_schema_invalid");
  return Number(value);
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("openai_tool_schema_invalid");
  return value;
}

function projectAnnotations(source: Record<string, unknown>, target: Record<string, unknown>): void {
  for (const keyword of ANNOTATION_KEYWORDS) {
    if (!(keyword in source)) continue;
    if (typeof source[keyword] !== "string") fail("openai_tool_schema_invalid");
    target[keyword] = source[keyword];
  }
}

function schemaAllowedKeywords(type: string | null, hasUnion: boolean): Set<string> {
  const allowed = new Set([...ANNOTATION_KEYWORDS, ...COMMON_KEYWORDS, ...STRIPPED_KEYWORDS]);
  if (hasUnion) {
    for (const keyword of UNION_KEYWORDS) allowed.add(keyword);
    return allowed;
  }
  if (type === "object") for (const keyword of OBJECT_KEYWORDS) allowed.add(keyword);
  if (type === "array") for (const keyword of ARRAY_KEYWORDS) allowed.add(keyword);
  if (type === "string") for (const keyword of STRING_KEYWORDS) allowed.add(keyword);
  if (type === "number" || type === "integer") {
    for (const keyword of NUMBER_KEYWORDS) allowed.add(keyword);
  }
  return allowed;
}

interface SchemaDomain {
  possibleTypes: ReadonlySet<string>;
  exactValues: ReadonlySet<string> | null;
}

function schemaDomain(schema: Record<string, unknown>): SchemaDomain | null {
  if (Array.isArray(schema.enum)) {
    const types = new Set<string>();
    const values = new Set<string>();
    for (const value of schema.enum) {
      if (!isJsonScalar(value)) return null;
      const type = scalarType(value);
      types.add(type === "integer" ? "number" : type);
      values.add(scalarKey(value));
    }
    return { possibleTypes: types, exactValues: values };
  }
  if (typeof schema.type === "string") {
    const type = schema.type === "integer" ? "number" : schema.type;
    return { possibleTypes: new Set([type]), exactValues: null };
  }
  if (Array.isArray(schema.anyOf)) {
    const domains = schema.anyOf.map((branch) => (
      isRecord(branch) ? schemaDomain(branch) : null
    ));
    if (domains.some((domain) => domain === null)) return null;
    const possibleTypes = new Set<string>();
    let exactValues: Set<string> | null = new Set<string>();
    for (const domain of domains as SchemaDomain[]) {
      for (const type of domain.possibleTypes) possibleTypes.add(type);
      if (exactValues && domain.exactValues) {
        for (const value of domain.exactValues) exactValues.add(value);
      } else {
        exactValues = null;
      }
    }
    return { possibleTypes, exactValues };
  }
  return null;
}

function domainsAreDisjoint(left: SchemaDomain, right: SchemaDomain): boolean {
  if (left.exactValues && right.exactValues) {
    return [...left.exactValues].every((value) => !right.exactValues!.has(value));
  }
  return [...left.possibleTypes].every((type) => !right.possibleTypes.has(type));
}

function oneOfCanBecomeAnyOf(branches: readonly Record<string, unknown>[]): boolean {
  const domains = branches.map(schemaDomain);
  if (domains.some((domain) => domain === null)) return false;
  for (let left = 0; left < domains.length; left += 1) {
    for (let right = left + 1; right < domains.length; right += 1) {
      if (!domainsAreDisjoint(domains[left]!, domains[right]!)) return false;
    }
  }
  return true;
}

function projectUnion(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): Record<string, unknown>[] {
  assertDenseArray(value);
  if (value.length === 0) fail("openai_tool_schema_invalid");
  return value.map((branch) => projectSchema(branch, depth + 1, false, ancestors));
}

function projectObject(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  depth: number,
  ancestors: Set<object>,
): void {
  if (source.additionalProperties !== false) fail("openai_tool_schema_not_strict");

  const rawProperties = "properties" in source ? source.properties : {};
  assertDataRecord(rawProperties);
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const propertyKeys = Object.keys(rawProperties);
  for (const key of propertyKeys) {
    properties[key] = projectSchema(rawProperties[key], depth + 1, false, ancestors);
  }

  if (propertyKeys.length > 0) {
    if (source.required === undefined) fail("openai_tool_schema_optional_property");
    assertDenseArray(source.required);
    if (source.required.length !== propertyKeys.length
      || source.required.some((key) => typeof key !== "string")
      || new Set(source.required as string[]).size !== propertyKeys.length
      || propertyKeys.some((key) => !(source.required as string[]).includes(key))) {
      fail("openai_tool_schema_optional_property");
    }
  } else if (source.required !== undefined) {
    assertDenseArray(source.required);
    if (source.required.length !== 0) fail("openai_tool_schema_invalid");
  }

  target.properties = properties;
  target.required = propertyKeys;
  target.additionalProperties = false;
}

function projectArray(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  depth: number,
  ancestors: Set<object>,
): void {
  if (!("items" in source) || Array.isArray(source.items) || "prefixItems" in source) {
    fail("openai_tool_schema_unsupported");
  }
  target.items = projectSchema(source.items, depth + 1, false, ancestors);
  if ("minItems" in source) target.minItems = nonNegativeInteger(source.minItems);
  if ("maxItems" in source) target.maxItems = nonNegativeInteger(source.maxItems);
  if (typeof target.minItems === "number" && typeof target.maxItems === "number"
    && target.minItems > target.maxItems) {
    fail("openai_tool_schema_invalid");
  }
}

function projectString(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if ("minLength" in source) target.minLength = nonNegativeInteger(source.minLength);
  if ("maxLength" in source) target.maxLength = nonNegativeInteger(source.maxLength);
  if (typeof target.minLength === "number" && typeof target.maxLength === "number"
    && target.minLength > target.maxLength) {
    fail("openai_tool_schema_invalid");
  }
  if ("pattern" in source) {
    if (typeof source.pattern !== "string") fail("openai_tool_schema_invalid");
    target.pattern = source.pattern;
  }
  if ("format" in source) {
    if (typeof source.format !== "string" || !SUPPORTED_STRING_FORMATS.has(source.format)) {
      fail("openai_tool_schema_unsupported");
    }
    target.format = source.format;
  }
}

function projectNumber(source: Record<string, unknown>, target: Record<string, unknown>): void {
  for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (keyword in source) target[keyword] = finiteNumber(source[keyword]);
  }
  if ("multipleOf" in source) {
    const multipleOf = finiteNumber(source.multipleOf);
    if (multipleOf <= 0) fail("openai_tool_schema_invalid");
    target.multipleOf = multipleOf;
  }
}

function projectSchema(
  value: unknown,
  depth: number,
  isRoot: boolean,
  ancestors: Set<object>,
): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) fail("openai_tool_schema_too_deep");
  assertDataRecord(value);
  if (ancestors.has(value)) fail("openai_tool_schema_invalid");
  ancestors.add(value);
  try {
    const meaningfulKeys = Object.keys(value).filter((key) => !STRIPPED_KEYWORDS.has(key));
    if (meaningfulKeys.length === 0) fail("openai_tool_schema_invalid");

    const hasAnyOf = "anyOf" in value;
    const hasOneOf = "oneOf" in value;
    if (hasAnyOf && hasOneOf) fail("openai_tool_schema_unsupported");
    if (isRoot && (hasAnyOf || hasOneOf)) fail("openai_tool_schema_root_union");

    const rawType = value.type;
    const type = rawType === undefined ? null : rawType;
    if (type !== null && (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))) {
      fail("openai_tool_schema_unsupported");
    }
    if (isRoot && type !== "object") fail("openai_tool_schema_not_strict");

    const hasUnion = hasAnyOf || hasOneOf;
    if (hasUnion && (type !== null || "enum" in value || "const" in value)) {
      fail("openai_tool_schema_unsupported");
    }
    const allowedKeywords = schemaAllowedKeywords(type, hasUnion);
    if (Object.keys(value).some((keyword) => !allowedKeywords.has(keyword))) {
      fail("openai_tool_schema_unsupported");
    }
    if (!hasUnion && type === null && !("enum" in value) && !("const" in value)) {
      fail("openai_tool_schema_invalid");
    }

    const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    projectAnnotations(value, projected);

    if (hasUnion) {
      const branches = projectUnion(hasAnyOf ? value.anyOf : value.oneOf, depth, ancestors);
      if (hasOneOf && !oneOfCanBecomeAnyOf(branches)) {
        fail("openai_tool_schema_unsupported");
      }
      projected.anyOf = branches;
      return projected;
    }

    if (type !== null) projected.type = type;
    if ("enum" in value && "const" in value) fail("openai_tool_schema_unsupported");
    if ("enum" in value) projected.enum = projectEnum(value.enum, type);
    if ("const" in value) {
      if (!isJsonScalar(value.const)) fail("openai_tool_schema_unsupported");
      if (type && !typeAllowsValue(type, value.const)) fail("openai_tool_schema_invalid");
      projected.enum = [value.const];
    }

    if (type === "object") projectObject(value, projected, depth, ancestors);
    if (type === "array") projectArray(value, projected, depth, ancestors);
    if (type === "string") projectString(value, projected);
    if (type === "number" || type === "integer") projectNumber(value, projected);
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function projectPortableStrictSubset(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectPortableStrictSubset);
  if (!value || typeof value !== "object") return value;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PORTABLE_STRIPPED_CONSTRAINTS.has(key)) continue;
    projected[key] = projectPortableStrictSubset(child);
  }
  return projected;
}

/**
 * Projects an already-generated JSON Schema into the deliberately small
 * OpenAI strict function-tool subset. It never mutates or widens the source
 * schema. Unsupported constructs fail with a stable, path-free safe error.
 */
export function projectOpenAiStrictToolSchema(
  source: unknown,
  options: OpenAiStrictToolSchemaProjectionOptions = {},
): Readonly<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SCHEMA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("openai_tool_schema_limit_invalid");
  }
  const profile = options.profile ?? "native";
  if (profile !== "native" && profile !== "portable") {
    fail("openai_tool_schema_profile_invalid");
  }
  const native = projectSchema(source, 0, true, new Set<object>());
  const projected = profile === "portable"
    ? projectPortableStrictSubset(native) as Record<string, unknown>
    : native;
  const encoded = JSON.stringify(projected);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    fail("openai_tool_schema_too_large");
  }
  // Return ordinary, prototype-safe JSON data detached from the source.
  return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
}
