import "./AutoVideoDurationButton.css";

export function videoDurationLabel(duration: number): string {
  return duration === -1 ? "自动" : `${duration} 秒`;
}

export function AutoVideoDurationButton(props: {
  supported?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!props.supported) return null;
  return (
    <button
      type="button"
      aria-label="自动时长"
      aria-pressed={props.selected}
      className={`autoVideoDurationButton${props.selected ? " selected" : ""}`}
      onClick={props.onSelect}
      title="由模型决定视频时长，费用按实际生成用量结算"
    >自动</button>
  );
}
