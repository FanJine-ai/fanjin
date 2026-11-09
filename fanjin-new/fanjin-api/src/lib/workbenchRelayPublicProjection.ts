import { publicH3Text } from "@/lib/minimaxH3PublicIdentity";
import {
  RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
  publicRelayStatus,
  shouldQuarantineRelayArtifacts,
} from "@/lib/relayMockPolicy";

export interface WorkbenchRelayVideoPublicInput {
  state?: string | null;
  filePath?: string | null;
  errorReason?: string | null;
  relayStatus?: string | null;
}

export interface WorkbenchRelayVideoPublicProjection {
  state: string;
  filePath: string;
  errorReason: string | null;
  relayStatus: string;
  syntheticQuarantined: boolean;
}

/**
 * Legacy fixture rows may still say that their bound video succeeded. Keep
 * those rows for audit/history, but never project their synthetic URL as a
 * playable workbench result outside the explicit test runtime.
 */
export function projectWorkbenchRelayVideoForPublic(
  input: WorkbenchRelayVideoPublicInput,
  runtime = process.env.NODE_ENV,
): WorkbenchRelayVideoPublicProjection {
  if (shouldQuarantineRelayArtifacts(input.relayStatus, runtime)) {
    return {
      state: "生成失败",
      filePath: "",
      errorReason: RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
      relayStatus: "failed",
      syntheticQuarantined: true,
    };
  }
  return {
    state: String(input.state || ""),
    filePath: String(input.filePath || ""),
    errorReason: input.errorReason == null
      ? null
      : publicH3Text(String(input.errorReason)),
    relayStatus: publicRelayStatus(
      String(input.relayStatus || ""),
      runtime,
    ),
    syntheticQuarantined: false,
  };
}
