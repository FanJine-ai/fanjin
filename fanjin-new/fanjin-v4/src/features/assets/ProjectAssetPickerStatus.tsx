export type ProjectAssetPickerStatusProps = {
  projectId: number | null;
  loading: boolean;
  errorMessage?: string | null;
  assetCount: number;
  visibleAssetCount?: number;
  className?: string;
  as?: "p" | "small";
};

export function getProjectAssetPickerStatus({
  projectId,
  loading,
  errorMessage,
  assetCount,
  visibleAssetCount = assetCount,
}: Omit<ProjectAssetPickerStatusProps, "as" | "className">): string | null {
  if (projectId === null) return "请先选择项目";
  if (loading) return "正在读取项目资产...";
  if (errorMessage) return errorMessage;
  if (assetCount === 0) return "当前项目还没有资产";
  if (visibleAssetCount === 0) return "没有匹配资产";
  return null;
}

export function ProjectAssetPickerStatus({
  as = "p",
  className,
  ...state
}: ProjectAssetPickerStatusProps) {
  const message = getProjectAssetPickerStatus(state);
  if (!message) return null;
  if (as === "small") {
    return <small className={className} role="status">{message}</small>;
  }
  return <p className={className} role="status">{message}</p>;
}
