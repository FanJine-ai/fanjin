import { useState } from "react";
import "./PortraitAdmissionPanel.css";

export type PortraitApprovalSnapshot = {
  projectId: number | null;
  assetVersionIds: readonly number[];
};

/** Approval is scoped to the same project and durable version as the panel. */
export function usePortraitAdmissionIndicators(projectId: number | string | null) {
  const [snapshot, onApprovalChange] = useState<PortraitApprovalSnapshot>({ projectId: null, assetVersionIds: [] });
  const approvedAssetVersionIds = projectId != null && Number(projectId) === snapshot.projectId
    ? snapshot.assetVersionIds
    : [];
  return { approvedAssetVersionIds, onApprovalChange };
}

export function PortraitAdmissionIndicator({ approved, name }: { approved: boolean; name: string }) {
  if (!approved) return null;
  return <span className="portraitAdmissionApprovedDot" role="img" aria-label={`${name}：检查已通过`} title="检查已通过" />;
}
