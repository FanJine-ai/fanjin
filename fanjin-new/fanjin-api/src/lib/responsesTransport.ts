import type { RelayChannel } from "@/lib/sharedTypes";

/** Missing config preserves the historical Chat Completions adapter. */
export function isNativeResponsesChannel(channel: Pick<RelayChannel, "provider" | "config">): boolean {
  return channel.provider === "volcano"
    || (channel.provider === "openai" && channel.config?.responsesTransport === "native");
}

export function responsesTransportConfigError(provider: string, endpointType: string, config: Record<string, unknown>): string | null {
  if (config.responsesTransport === undefined) return null;
  if (provider !== "openai" || endpointType !== "text") return "responsesTransport 仅适用于 OpenAI 文本通道";
  if (typeof config.responsesTransport !== "string" || !["native", "chat_completions"].includes(config.responsesTransport)) return "responsesTransport 必须为 native 或 chat_completions";
  return null;
}
