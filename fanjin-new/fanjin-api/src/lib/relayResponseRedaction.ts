import type { RelayTask } from "@/lib/relay";

const SERVER_ONLY_RELAY_KEYS = new Set([
  "billingAuthorization",
]);

export function redactServerOnlyRelayMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactServerOnlyRelayMetadata(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SERVER_ONLY_RELAY_KEYS.has(key))
      .map(([key, item]) => [key, redactServerOnlyRelayMetadata(item)]),
  );
}

export function adminRelayTaskResponse(task: RelayTask): RelayTask {
  return {
    ...task,
    providerPayload: redactServerOnlyRelayMetadata(
      task.providerPayload,
    ) as Record<string, unknown>,
  };
}
