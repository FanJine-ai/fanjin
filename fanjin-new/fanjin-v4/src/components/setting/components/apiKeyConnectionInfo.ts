export type ApiKeyConnectionModelOption = {
  value: string;
  endpointType?: string;
  status?: string;
};

function cleanModelIds(values: readonly string[]): string[] {
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

const SENSITIVE_ENDPOINT_PARAMETER = /(?:token|apikey|authorization|credential|password|passwd|secret|signature)/;
const TOKEN_LIKE_ENDPOINT_VALUE = /(?:^|[^a-z0-9])(?:bearer\s+|sk-|fj_(?:live|test|prod)_|eyj[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+)/i;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;
const MAX_ENDPOINT_URL_LENGTH = 8_192;
const MAX_ENDPOINT_COMPONENT_LENGTH = 8_192;
const MAX_ENDPOINT_PERCENT_DECODE_LAYERS = 4;
const MAX_ENDPOINT_QUERY_PARAMETERS = 128;

function endpointParameterNameIsSensitive(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "key" || normalized === "auth" || SENSITIVE_ENDPOINT_PARAMETER.test(normalized);
}

function endpointPathHasSensitiveParameter(pathname: string): boolean {
  const parameterPattern = /(?:^|[^a-z0-9])(?=([a-z0-9._%+-]+)=)/gi;
  for (const match of pathname.matchAll(parameterPattern)) {
    if (endpointParameterNameIsSensitive(match[1])) return true;
  }
  return false;
}

function percentDecodedLayers(value: string, allowDecodedLiteralPercent = false): string[] | null {
  if (value.length > MAX_ENDPOINT_COMPONENT_LENGTH) return null;

  const layers = [value];
  let current = value;
  let decodedAtLeastOnce = false;
  for (let depth = 0; depth < MAX_ENDPOINT_PERCENT_DECODE_LAYERS; depth += 1) {
    if (!current.includes("%")) return layers;
    if (!PERCENT_ESCAPE.test(current)) {
      return decodedAtLeastOnce || allowDecodedLiteralPercent ? layers : null;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded.length > MAX_ENDPOINT_COMPONENT_LENGTH) return null;
    if (decoded === current) return layers;
    layers.push(decoded);
    current = decoded;
    decodedAtLeastOnce = true;
  }

  if (!current.includes("%") || !PERCENT_ESCAPE.test(current)) return layers;
  return null;
}

function pathLayersAreSafe(value: string, allowDecodedLiteralPercent = false): boolean {
  const layers = percentDecodedLayers(value, allowDecodedLiteralPercent);
  return Boolean(layers && layers.every((layer) => (
    !endpointPathHasSensitiveParameter(layer)
    && !TOKEN_LIKE_ENDPOINT_VALUE.test(layer)
  )));
}

/**
 * Connection examples are copied verbatim by operators, so an endpoint must
 * never carry credentials. Keep this validation at the final rendering
 * boundary as well as at the API response consumer.
 */
export function sanitizeApiKeyConnectionEndpoint(endpointUrl: unknown): string | null {
  if (
    typeof endpointUrl !== "string"
    || endpointUrl !== endpointUrl.trim()
    || !endpointUrl
    || endpointUrl.length > MAX_ENDPOINT_URL_LENGTH
  ) return null;

  try {
    const parsed = new URL(endpointUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.hash) return null;
    if (parsed.href.length > MAX_ENDPOINT_URL_LENGTH || !pathLayersAreSafe(parsed.pathname)) return null;

    const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
    if (rawQuery && !pathLayersAreSafe(rawQuery)) return null;

    let queryParameterCount = 0;
    for (const [name, value] of parsed.searchParams) {
      queryParameterCount += 1;
      if (queryParameterCount > MAX_ENDPOINT_QUERY_PARAMETERS) return null;
      const nameLayers = percentDecodedLayers(name, true);
      const valueLayers = percentDecodedLayers(value, true);
      if (
        !nameLayers
        || !valueLayers
        || nameLayers.some(endpointParameterNameIsSensitive)
        || valueLayers.some((layer) => (
          endpointPathHasSensitiveParameter(layer)
          || TOKEN_LIKE_ENDPOINT_VALUE.test(layer)
        ))
      ) return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function resolveApiKeyConnectionModel(
  modelAllowlist: readonly string[],
  modelOptions: readonly ApiKeyConnectionModelOption[],
): string | null {
  const availableModels = cleanModelIds(
    modelOptions
      .filter((option) => {
        return option.status === "active" && option.endpointType === "video_generation";
      })
      .map((option) => option.value),
  );
  if (!availableModels.length) return null;

  const allowedModels = cleanModelIds(modelAllowlist);
  if (!allowedModels.length) return availableModels[0];

  const availableSet = new Set(availableModels);
  return allowedModels.find((model) => availableSet.has(model)) || null;
}

export function resolveApiKeyTextConnectionModel(
  modelAllowlist: readonly string[],
  modelOptions: readonly ApiKeyConnectionModelOption[],
): string | null {
  const availableModels = cleanModelIds(modelOptions
    .filter((option) => option.status === "active" && option.endpointType === "text")
    .map((option) => option.value));
  const allowedModels = cleanModelIds(modelAllowlist);
  return allowedModels.length
    ? allowedModels.find((model) => availableModels.includes(model)) || null
    : availableModels[0] || null;
}

export function buildTextApiKeyConnectionInfo(apiBaseUrl: string, model: string): string | null {
  let endpoint: string;
  try {
    endpoint = new URL("/v1/chat/completions", apiBaseUrl).toString();
  } catch {
    return null;
  }
  const safeEndpoint = sanitizeApiKeyConnectionEndpoint(endpoint);
  if (!safeEndpoint || !model.trim()) return null;
  const requestBody = JSON.stringify({ model, messages: [{ role: "user", content: "你好" }] });
  return [
    `Endpoint: ${safeEndpoint}`,
    "所需权限: relay:text",
    "API Key: 请使用创建或轮换时保存的明文密钥",
    "",
    `curl -X POST ${shellSingleQuote(safeEndpoint)} -H "Content-Type: application/json" -H "Authorization: Bearer <YOUR_FANJIN_API_KEY>" -d ${shellSingleQuote(requestBody)}`,
  ].join("\n");
}

export function buildApiKeyConnectionInfo(
  endpointUrl: string,
  model: string,
  projectId: number,
): string | null {
  const safeEndpointUrl = sanitizeApiKeyConnectionEndpoint(endpointUrl);
  if (!safeEndpointUrl || !Number.isSafeInteger(projectId) || projectId <= 0) return null;

  const requestBody = JSON.stringify({
    projectId,
    model,
    content: [{
      type: "text",
      text: "一段雨夜城市街角的电影感镜头",
    }],
    ratio: "16:9",
    resolution: "1080p",
    duration: 8,
  });

  return [
    `Endpoint: ${safeEndpointUrl}`,
    "API Key: 请使用创建或轮换时保存的明文密钥",
    "",
    `curl -X POST ${shellSingleQuote(safeEndpointUrl)} -H "Content-Type: application/json" -H "Authorization: Bearer <YOUR_FANJIN_API_KEY>" -d ${shellSingleQuote(requestBody)}`,
  ].join("\n");
}

export function buildMcpConnectionInfo(endpointUrl: string): string {
  const mcpUrl = new URL("/api/mcp", endpointUrl).toString();
  return [
    `MCP URL: ${mcpUrl}`,
    "API Key: 请使用包含 mcp:connect 权限的工作区密钥",
    "",
    'export FANJIN_MCP_TOKEN="<YOUR_FANJIN_API_KEY>"',
    `codex mcp add fanjin --url ${shellSingleQuote(mcpUrl)} --bearer-token-env-var FANJIN_MCP_TOKEN`,
  ].join("\n");
}
