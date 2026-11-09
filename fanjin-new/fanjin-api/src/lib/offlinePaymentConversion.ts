import crypto from "node:crypto";
import { guPerYuan, ledgerAtomsPerCnyMicro } from "./billingUnits";

export const offlineConversionPolicyVersion = "cny-gu/v2";
export type OfflineConversionPolicyVersion = "cny-gu/v1" | typeof offlineConversionPolicyVersion;

export function offlineCreditedAmountMicros(tenderAmountMicros: number): number | null {
  if (!Number.isSafeInteger(tenderAmountMicros) || tenderAmountMicros <= 0) return null;
  const credited = BigInt(tenderAmountMicros) * BigInt(ledgerAtomsPerCnyMicro);
  return credited <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(credited) : null;
}

export function offlineConversionSnapshotHash(
  tenderAmountMicros: number,
  creditedAmountMicros: number,
  policy: OfflineConversionPolicyVersion = offlineConversionPolicyVersion,
): string {
  // Existing signed receipts retain their original denomination. Only new receipts
  // use v2; the underlying CNY-to-ledger conversion is unchanged in both versions.
  const snapshot = {
    policy,
    guPerYuan: policy === "cny-gu/v1" ? 1000 : guPerYuan,
    tenderAmountMicros,
    creditedAmountMicros,
  };
  const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function offlineConversionProofMatches(
  policy: unknown,
  hash: unknown,
  tenderAmountMicros: number,
  creditedAmountMicros: number,
): boolean {
  return (policy === "cny-gu/v1" || policy === offlineConversionPolicyVersion)
    && offlineCreditedAmountMicros(tenderAmountMicros) === creditedAmountMicros
    && hash === offlineConversionSnapshotHash(tenderAmountMicros, creditedAmountMicros, policy);
}
