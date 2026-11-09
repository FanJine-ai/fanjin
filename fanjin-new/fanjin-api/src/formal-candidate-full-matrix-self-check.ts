/**
 * Zero-I/O self-check snapshot for the signed full-matrix artifact.
 *
 * Keep this module dependency-free. The signed entrypoint loads it before the
 * paid driver graph, whose database-backed authorization read model must not
 * be initialized by a self-check. A parity test binds this snapshot to the
 * plan-derived report in verify-workbench-full-matrix-real-candidate.ts.
 */
export function formalCandidateFullMatrixSelfCheck(): Record<string, unknown> {
  return {
    ok: true,
    mode: "self-check",
    networkRequests: 0,
    paidRequests: 0,
    keychainReads: 0,
    sessionReads: 0,
    evidenceReads: 0,
    planVersion: "fanjin-workbench-full-matrix-plan/v4",
    planDigest: "sha256:c50559efcaa1cd8ce950fd080e34e80a7f7a202ffaf77b883163f0fc419fca4f",
    calls: { total: 41, text: 5, image: 24, video: 12 },
    expectedCostLimitMicros: 192_125_600_000,
    spendStopMicros: 200_000_000_000,
    publicVideoResolutions: ["720p", "1080p"],
    omniReferenceVideoInputs: {
      count: 2,
      totalDurationSeconds: 9,
      maximumDurationSeconds: 15.2,
    },
    highResolutionVideoFailClosed: true,
    automaticPaidRetry: false,
    videoStatusPollRecovery: {
      method: "GET",
      sameTaskOnly: true,
      generationSubmissions: 0,
      retryableReadFailures: [
        "transport-or-timeout",
        "malformed-or-truncated-json",
      ],
      monotonicDeadlineBounded: true,
    },
    recoveryRequiresLiveRevalidation: true,
    executionUsageBinding: "workspace+request+freeze-deduct+task",
    imageCountTwoZeroSideEffectGate: true,
    negativeGatesOnly: {
      exactAcknowledgementRequired: true,
      rejectedPreDispatchRequests: 2,
      cases: ["image-count-2", "image-quality-8k"],
      snapshots: [
        "tasks",
        "library-assets",
        "project-image-assets",
        "usage",
        "ledgers",
        "reserved-micros",
      ],
      paidCallsStarted: 0,
      generationSubmissions: 0,
      upstreamGenerationSubmissions: 0,
      privateEvidenceMode: "0600",
    },
    completedAssetVersionOnlineRevalidation: true,
    permanentSessionPaidGuard: true,
    sealedManifest: true,
    explicitResume: true,
    reconcileOnlyGenerationSubmissions: 0,
    closedNoChargeCountsAsSuccess: false,
    closedNoChargeRetryable: false,
    noChargeClosureRequires: [
      "released-zero-cost-usage",
      "fully-released-reservation",
      "resolved-reconciliation",
      "zero-generation-artifacts",
      "zero-pending-tasks",
    ],
    videoDeadlineMs: {
      "video/doubao-seedance-2-0-260128/text_to_video": 525_000,
      "video/doubao-seedance-2-0-260128/image_to_video": 480_000,
      "video/doubao-seedance-2-0-260128/first_last_frame": 975_000,
      "video/doubao-seedance-2-0-260128/omni_reference": 525_000,
      "video/doubao-seedance-2-0-fast-260128/text_to_video": 445_000,
      "video/doubao-seedance-2-0-fast-260128/image_to_video": 410_000,
      "video/doubao-seedance-2-0-fast-260128/first_last_frame": 795_000,
      "video/doubao-seedance-2-0-fast-260128/omni_reference": 445_000,
      "video/doubao-seedance-2-0-mini-260615/text_to_video": 500_000,
      "video/doubao-seedance-2-0-mini-260615/image_to_video": 460_000,
      "video/doubao-seedance-2-0-mini-260615/first_last_frame": 900_000,
      "video/doubao-seedance-2-0-mini-260615/omni_reference": 500_000,
    },
    outputRedacted: true,
  };
}
