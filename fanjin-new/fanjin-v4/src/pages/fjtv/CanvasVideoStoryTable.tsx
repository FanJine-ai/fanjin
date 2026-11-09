import type { VideoStoryAnalysis, VideoStoryShot } from "./canvasDataTypes";
import ReferencePreviewImage from "@/features/quick-create/attachments/ReferencePreviewImage";

interface CanvasVideoStoryTableProps {
  analysis: VideoStoryAnalysis;
  fullscreen?: boolean;
  nodeId?: string;
  updateVideoStoryCell: (nodeId: string, rowIndex: number, key: string, value: string) => void;
}

export const VIDEO_STORY_COLUMNS = [
{ key: "shot", label: "镜号", width: 96 },
{ key: "startTime", label: "开始时间", width: 150 },
{ key: "endTime", label: "结束时间", width: 150 },
{ key: "duration", label: "时长", width: 130 },
{ key: "visualDescription", label: "画面描述", width: 300 },
{ key: "narrative", label: "叙事内容", width: 300 },
{ key: "shotSize", label: "景别", width: 150 },
{ key: "cameraAngle", label: "摄影机角度", width: 180 },
{ key: "cameraMovement", label: "摄影机运动", width: 180 },
{ key: "focusDepth", label: "焦距与景深", width: 230 },
{ key: "lighting", label: "光线", width: 270 },
{ key: "backgroundMusic", label: "背景音乐", width: 210 },
{ key: "voiceSound", label: "人声/音效", width: 220 },
{ key: "subtitle", label: "字幕", width: 220 },
{ key: "imagePrompt", label: "图像生成提示词", width: 250 },
{ key: "videoMotionPrompt", label: "视频运动提示词", width: 250 },
{ key: "keywords", label: "关键词", width: 180 },
] as const;

export function formatVideoStorySeconds(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (Math.abs(num - Math.round(num)) < 0.01) return String(Math.round(num));
  return String(Math.round(num * 10) / 10).replace(/\.0$/, "");
}

export function getVideoStoryCell(row: VideoStoryShot, key: string) {
  if (key === "shot") return String(row.shot || "");
  if (key === "startTime") return formatVideoStorySeconds(row.startTime);
  if (key === "endTime") return formatVideoStorySeconds(row.endTime);
  if (key === "duration") return formatVideoStorySeconds(row.duration);
  return String((row as any)[key] || "");
}

export function CanvasVideoStoryTable({ analysis, fullscreen = false, nodeId, updateVideoStoryCell }: CanvasVideoStoryTableProps) {
  const rows = Array.isArray(analysis.rows) ? analysis.rows : [];
  const editableKeys = new Set([
    "visualDescription", "narrative", "shotSize", "cameraAngle", "cameraMovement",
    "focusDepth", "lighting", "backgroundMusic", "voiceSound", "subtitle",
    "imagePrompt", "videoMotionPrompt", "keywords",
  ]);
  const tableWidth = VIDEO_STORY_COLUMNS.reduce((sum, column) => sum + column.width, 0) + 136;
  return (
    <div className={fullscreen ? "h-[calc(100vh-168px)] overflow-auto" : "max-h-[276px] overflow-auto"}>
      <table className="border-collapse text-left text-[14px] text-[#f0f1f4]" style={{ minWidth: tableWidth }}>
        <colgroup>
          {VIDEO_STORY_COLUMNS.map((column) => <col key={column.key} style={{ width: column.width }} />)}
          <col style={{ width: 136 }} />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[#383838] text-[#9d9fa5]">
          <tr>
            {VIDEO_STORY_COLUMNS.map((column) => (
              <th key={column.key} className="border-b border-r border-[#28292c] px-4 py-3 text-[14px] font-medium">
                {column.label}
              </th>
            ))}
            <th className="border-b border-r border-[#28292c] px-4 py-3 text-[14px] font-medium">关键帧</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.shot || rowIndex} className="bg-[#111111]/96 align-top">
              {VIDEO_STORY_COLUMNS.map((column) => (
                <td key={column.key} className="border-b border-r border-[#2b2c30] px-3 py-3 leading-6 text-white/92">
                  {nodeId && editableKeys.has(column.key) ? (
                    <textarea
                      aria-label={`${column.label} ${row.shot}`}
                      className={`${fullscreen ? "min-h-[118px]" : "min-h-[84px]"} w-full resize-y rounded-[6px] border border-white/8 bg-transparent p-2 leading-6 text-white outline-none focus:border-white/28`}
                      value={getVideoStoryCell(row, column.key)}
                      onChange={(event) => updateVideoStoryCell(nodeId, rowIndex, column.key, event.target.value)}
                    />
                  ) : (
                    <div className={fullscreen ? "max-h-[196px] overflow-y-auto pr-2" : "max-h-[144px] overflow-y-auto pr-2"}>
                      {getVideoStoryCell(row, column.key)}
                    </div>
                  )}
                </td>
              ))}
              <td className="border-b border-r border-[#2b2c30] px-3 py-4">
                {row.keyframeUrl ? (
                  <ReferencePreviewImage src={row.keyframeUrl} alt={"关键帧" + row.shot} className="h-[72px] w-[112px] rounded-[4px] object-cover" />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
