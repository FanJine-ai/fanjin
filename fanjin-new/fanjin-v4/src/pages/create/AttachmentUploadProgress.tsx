import { attachmentStateText, attachmentTransferredText } from "./quickCreatePresentation";
import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";

export default function AttachmentUploadProgress({attachment}: {attachment: AttachmentQueueItem}) {
  if (attachment.state !== "uploading" && attachment.state !== "queued") return null;
  const percent = Math.max(0, Math.min(100, Math.round(attachment.progress)));
  return (
    <span
      className="jimengAttachmentProgress"
      role="progressbar"
      aria-label={`${attachment.name} 上传进度`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={[attachmentStateText(attachment), attachmentTransferredText(attachment)].filter(Boolean).join(" · ")}
      title={[attachmentStateText(attachment), attachmentTransferredText(attachment)].filter(Boolean).join(" · ")}
    >
      <span style={{width: `${percent}%`}} />
    </span>
  );
}
