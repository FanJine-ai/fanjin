import type { Knex } from "knex";
export declare const AGENT_CHANNEL_CONFIGURATION_SOURCE = "fanjin-agent-channel-config-v1";
export declare const NEWAPI_CHANNEL_ID = "fanjin-agent-newapi-sine-text";
export declare const NEWAPI_CHANNEL_NAME = "Sine NewAPI Agent Text";
export declare const NEWAPI_BASE_URL = "https://sine.fmusic.cc/v1";
export declare const NEWAPI_HEALTH_PROBE_URL = "https://sine.fmusic.cc/v1/models";
export declare const NEWAPI_CREDENTIAL_REF = "FANJIN_PROVIDER_NEWAPI_SINE_API_KEY";
export declare const AGENT_MAIN_MODEL = "agent-main";
export declare const CLAUDE_AGENT_MODEL = "claude-opus-4-8";
export declare const GPT_LUNA_MODEL = "gpt-5.6-luna";
export declare const NEWAPI_PRICING_SOURCE_URL = "https://sine.fmusic.cc/api/pricing";
export declare const NEWAPI_RATIO_CONFIG_URL = "https://sine.fmusic.cc/api/ratio_config";
export declare const NEWAPI_QUOTA_PER_USD = 500000;
export declare const NEWAPI_USD_CNY_RATE = 7.2;
export declare const AGENT_MODEL_PRICING: {
    readonly "claude-opus-4-8": {
        readonly inputPriceMicros: number;
        readonly outputPriceMicros: number;
        readonly cachePriceMicros: number;
        readonly cacheReadPriceMicros: number;
        readonly cacheWritePriceMicros: number;
        readonly modelRatio: number;
        readonly completionRatio: number;
        readonly cacheRatio: number;
        readonly createCacheRatio: number;
    };
    readonly "gpt-5.6-luna": {
        readonly inputPriceMicros: number;
        readonly outputPriceMicros: number;
        readonly cachePriceMicros: number;
        readonly cacheReadPriceMicros: number;
        readonly cacheWritePriceMicros: number;
        readonly modelRatio: number;
        readonly completionRatio: number;
        readonly cacheRatio: number;
        readonly createCacheRatio: number;
    };
};
interface AgentRouteSeed {
    id: string;
    name: string;
    displayName: string;
    description: string;
    model: string;
    upstreamModel: string;
    pricingStatus: "provisional" | "unpriced";
}
interface AgentPricingSeed {
    id: string;
    name: string;
    model: string;
    upstreamModel: string;
    aliasOf?: string;
    pricing: (typeof AGENT_MODEL_PRICING)[keyof typeof AGENT_MODEL_PRICING];
}
export declare const AGENT_ROUTE_SEEDS: readonly AgentRouteSeed[];
export declare const AGENT_PRICING_SEEDS: readonly AgentPricingSeed[];
export declare const AGENT_CHAT_CATALOG_PRICING_ID = "fanjin-agent-chat-catalog-agent-main";
export declare const UNPRICED_AGENT_MODELS: readonly {
    model: string;
    status: "unpriced";
    reason: string;
}[];
export declare const NEWAPI_CHANNEL_CONFIG: {
    readonly source: "fanjin-agent-channel-config-v1";
    readonly credentialStorage: "environment-reference-only";
    readonly healthProbeUrl: "https://sine.fmusic.cc/v1/models";
    readonly modelMapping: {
        readonly "agent-main": "claude-opus-4-8";
    };
    readonly modelRequestProfiles: {
        readonly "gpt-5.6-luna": {
            readonly omit: readonly ["temperature", "top_p"];
            readonly maxOutputTokensField: "max_completion_tokens";
        };
    };
    readonly unpricedModels: string[];
};
export interface AgentChannelConfigurationResult {
    channelId: string;
    routeIds: string[];
    pricingRuleIds: string[];
    unpricedModels: string[];
}
export declare function configureAgentChannels(database: Knex, timestamp?: number): Promise<AgentChannelConfigurationResult>;
type ConfigureMode = "dry-run" | "apply";
export declare function parseConfigureMode(args: string[]): ConfigureMode;
export declare function safeConfigurationSummary(mode: ConfigureMode, result?: AgentChannelConfigurationResult): {
    ok: boolean;
    mode: ConfigureMode;
    applied: boolean;
    secretPolicy: {
        inlineCredentialsStored: boolean;
        credentialRefs: string[];
    };
    channel: {
        id: string;
        name: string;
        provider: string;
        endpointType: string;
        baseUrl: string;
        credentialRef: string;
        healthProbeUrl: string;
        models: string[];
    };
    routes: {
        id: string;
        model: string;
        upstreamModel: string;
        status: string;
        pricingStatus: "provisional" | "unpriced";
    }[];
    pricing: {
        inputPriceMicros: number;
        outputPriceMicros: number;
        cachePriceMicros: number;
        cacheReadPriceMicros: number;
        cacheWritePriceMicros: number;
        modelRatio: number;
        completionRatio: number;
        cacheRatio: number;
        createCacheRatio: number;
        id: string;
        model: string;
        upstreamModel: string;
        unit: string;
        provider: string;
        status: string;
        source: string;
    }[];
    agentChatCatalogPricing: {
        id: string;
        model: string;
        unit: string;
        unitPriceMicros: number;
        billingMode: string;
    };
    unpricedModels: readonly {
        model: string;
        status: "unpriced";
        reason: string;
    }[];
    result: AgentChannelConfigurationResult | null;
};
export {};
