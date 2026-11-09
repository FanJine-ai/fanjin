import { parseProviderChannelConfig } from "@/lib/providerChannelSecrets";
import { openVendorInputValues } from "@/lib/vendorInputSecrets";
import { isFormalCandidateCredentialRuntimeDeclared } from "@/lib/formalCandidateCredentialRuntime";
import { assertProviderDispatchAllowed } from "@/lib/relayChannelCredential";

export const FORMAL_CANDIDATE_LEGACY_VENDOR_CREDENTIAL_FORBIDDEN =
  "FORMAL_CANDIDATE_LEGACY_VENDOR_CREDENTIAL_FORBIDDEN" as const;

export class FormalCandidateLegacyVendorCredentialError extends Error {
  readonly code = FORMAL_CANDIDATE_LEGACY_VENDOR_CREDENTIAL_FORBIDDEN;

  constructor() {
    super(FORMAL_CANDIDATE_LEGACY_VENDOR_CREDENTIAL_FORBIDDEN);
    this.name = "FormalCandidateLegacyVendorCredentialError";
  }
}

/**
 * The signed formal runtime may receive provider credentials only through its
 * bounded FD6 capability. Legacy DB, encrypted-value and environment fallback
 * paths must fail before inspecting any caller-owned value.
 */
export function assertLegacyVendorCredentialMaterializationAllowed(): void {
  // Legacy vendor code can carry credentials in stored inputValues and does
  // not necessarily pass through the Relay channel resolver. Preview closes
  // this boundary before any value is decrypted or materialized.
  assertProviderDispatchAllowed();
  if (isFormalCandidateCredentialRuntimeDeclared()) {
    throw new FormalCandidateLegacyVendorCredentialError();
  }
}

/**
 * Materialize a legacy vendor's runtime inputs from an environment reference.
 * The resolved value exists only in process memory and is never written back.
 */
export function resolveVendorRuntimeInputs(
  raw: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  vendorId = "legacy",
): Record<string, unknown> {
  assertLegacyVendorCredentialMaterializationAllowed();
  const inputValues = { ...openVendorInputValues(vendorId, parseProviderChannelConfig(raw)) };
  const credentialRef = typeof inputValues.credentialRef === "string" ? inputValues.credentialRef.trim() : "";
  if (credentialRef && environment[credentialRef]) {
    inputValues.apiKey = String(environment[credentialRef]);
  }
  return inputValues;
}
