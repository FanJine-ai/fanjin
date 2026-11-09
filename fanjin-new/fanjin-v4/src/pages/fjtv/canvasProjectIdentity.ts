import { normalizeProjectId } from "@/stores/projectStore";

export function sameProjectIdentity(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
) {
  const leftValue = left === null || left === undefined ? "" : String(left).trim();
  const rightValue = right === null || right === undefined ? "" : String(right).trim();
  if (!leftValue || !rightValue) return false;
  const leftNumericId = normalizeProjectId(leftValue);
  const rightNumericId = normalizeProjectId(rightValue);
  if (leftNumericId !== null && rightNumericId !== null) return leftNumericId === rightNumericId;
  return leftValue === rightValue;
}
