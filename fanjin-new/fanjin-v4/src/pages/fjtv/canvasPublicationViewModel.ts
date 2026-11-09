export function getCanvasPublicationStatusLabel(status: string) {
  return status === "pending_review" ? "审核中" : status === "published" ? "已发布" : status === "rejected" ? "未通过" : "已下架";
}

export function getActiveCanvasShares<T extends { status: string }>(shares: T[]) {
  return shares.filter((share) => share.status === "active").slice(0, 5);
}
