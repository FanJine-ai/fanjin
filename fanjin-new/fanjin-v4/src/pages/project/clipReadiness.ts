export type ClipReadinessSummaryInput = {
  loading: boolean;
  clipCount: number;
  projectId: string | number | null | undefined;
  trackCount: number;
  missingCount: number;
};

export function getClipReadinessSummary(input: ClipReadinessSummaryInput) {
  if (input.loading && input.clipCount === 0) return "正在读取成片素材";
  if (!input.projectId) return "请选择项目后进入剪辑";
  if (input.trackCount === 0) return "暂无视频轨道";
  if (input.missingCount > 0) return `${input.missingCount} 条镜头缺少可剪辑视频`;
  return "所有可用镜头已载入剪辑台";
}
