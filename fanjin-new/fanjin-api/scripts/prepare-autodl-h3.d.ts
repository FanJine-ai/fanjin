/** Offline only. Credentials are installed separately; no runtime is activated here. */
export declare function prepareAutoDLH3Configuration(guPerCny: number, timestamp?: number, healthProbeTaskId?: string): {
    version: string;
    guPerCny: number;
    documentation: string;
    activationRequired: string[];
    channel: {
        id: string;
        name: string;
        baseUrl: string;
        credentialRef: string;
        configJson: string;
        modelNames: string;
        priority: number;
        weight: number;
        timeoutMs: number;
        concurrencyLimit: number;
        scope: string;
        workspaceId: null;
        provider: string;
        endpointType: string;
        disabled: number;
        createTime: number;
        updateTime: number;
    };
    route: {
        id: string;
        name: string;
        displayName: string;
        model: "autodl-h3";
        channelId: string;
        priority: number;
        fallbackOrder: number;
        routeConfig: string;
        scope: string;
        workspaceId: null;
        provider: string;
        endpointType: string;
        disabled: number;
        createTime: number;
        updateTime: number;
    };
    pricing: {
        id: string;
        name: string;
        model: "autodl-h3";
        unit: string;
        currency: string;
        unitPriceMicros: number;
        ruleConfig: string;
        scope: string;
        workspaceId: null;
        provider: string;
        endpointType: string;
        disabled: number;
        createTime: number;
        updateTime: number;
    };
};
