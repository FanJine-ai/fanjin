export type PricingGroupStatus = "active" | "disabled";

export interface PricingGroup {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PricingGroupStatus;
  sortOrder: number;
  memberCount: number;
  pricingTargetCount: number;
  isDefault: boolean;
  canDelete: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PricingGroupDraft {
  code: string;
  name: string;
  description: string;
  status: PricingGroupStatus;
  sortOrder: number;
}
