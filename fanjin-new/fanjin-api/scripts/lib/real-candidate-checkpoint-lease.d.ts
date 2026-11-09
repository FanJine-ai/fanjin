declare const LEASE_BRAND: unique symbol;
export type RealCandidateCheckpointLeasePurpose = "candidate-start" | "candidate-recovery" | "readonly-evidence" | "timed-out-reconcile" | "terminal-cleanup";
export type RealCandidateCheckpointLease = {
    helperPid: number;
    assertHeld: () => void;
    assertBoundTo: (input: Readonly<{
        anonymousBinding: string;
        purpose: RealCandidateCheckpointLeasePurpose;
    }>) => void;
    release: () => Promise<void>;
    readonly [LEASE_BRAND]: true;
};
export declare class RealCandidateCheckpointLeaseError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function assertRealCandidateCheckpointLeaseCapability(lease: RealCandidateCheckpointLease): RealCandidateCheckpointLease;
export declare function acquireRealCandidateCheckpointLease(input: {
    checkpointRoot: string;
    checkpointLeafName: string;
    anonymousBinding: string;
    purpose: RealCandidateCheckpointLeasePurpose;
    onUnexpectedLoss?: () => void;
}): Promise<RealCandidateCheckpointLease>;
export declare function terminateProcessOnCheckpointLeaseLoss(): never;
export {};
