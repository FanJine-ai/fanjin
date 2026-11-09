import { PortraitAdmissionIndicator } from "../../features/portrait-admission/PortraitAdmissionIndicator";
import { useUploadQueueStore } from "../../features/quick-create/attachments/uploadQueue";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  FileAudio,
  Image as ImageIcon,
  Plus,
  X,
} from "lucide-react";
import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";
import type {
  QuickCreateVideoAttachmentKind,
  QuickCreateVideoReferenceRole,
} from "../../features/quick-create/modelCatalog";
import ReferencePreviewImage from "../../features/quick-create/attachments/ReferencePreviewImage";
import AttachmentUploadProgress from "./AttachmentUploadProgress";
import {attachmentStateText, attachmentTransferredText} from "./quickCreatePresentation";
import {
  ReferencePreviewAudio,
  ReferencePreviewVideo,
} from "../../features/quick-create/attachments/AuthenticatedReferenceMedia";

export type VideoReferenceAssignment = {
  preferredRole?: QuickCreateVideoReferenceRole;
  slotId?: string;
  order: number;
};

export type VideoReferencePickerRequest = {
  kind: QuickCreateVideoAttachmentKind | "mixed";
  preferredRole?: QuickCreateVideoReferenceRole;
  replaceClientId?: string;
  multiple?: boolean;
};

export type VideoReferenceCapacity = {
  total: { used: number; max: number };
  image: { used: number; max: number };
  video: { used: number; max: number };
  file: { used: number; max: number };
};

type Props = {
  mode: string;
  attachments: AttachmentQueueItem[];
  assignments: Record<string, VideoReferenceAssignment>;
  maxItems: number;
  capacity?: VideoReferenceCapacity;
  approvedAssetVersionIds?: readonly number[];
  onAdd: (request: VideoReferencePickerRequest) => void;
  onRemove: (clientId: string) => void;
  onMove: (clientId: string, direction: -1 | 1) => void;
};

function attachmentKind(attachment: AttachmentQueueItem): QuickCreateVideoAttachmentKind {
  if (attachment.mimeType.startsWith("image/")) return "image";
  if (attachment.mimeType.startsWith("video/")) return "video";
  return "file";
}

function ReferencePreview({ attachment }: { attachment: AttachmentQueueItem }) {
  const kind = attachmentKind(attachment);
  if (kind === "image") return <ReferencePreviewImage src={attachment.previewUrl} alt="" />;
  if (kind === "video") {
    return (
      <ReferencePreviewVideo
        src={attachment.previewUrl}
        aria-label={`播放 ${attachment.name}`}
        onLoadedMetadata={(event) => useUploadQueueStore.getState().setMediaDuration(attachment.clientId, event.currentTarget.duration)}
        controls
        muted
      />
    );
  }
  return (
    <span className="jimengReferenceMediaFallback">
      <FileAudio size={20} />
      <small>音频</small>
      <ReferencePreviewAudio
        src={attachment.previewUrl}
        aria-label={`播放 ${attachment.name}`}
        onLoadedMetadata={(event) => useUploadQueueStore.getState().setMediaDuration(attachment.clientId, event.currentTarget.duration)}
        controls
      />
    </span>
  );
}

function EmptyReferenceTile({
  label,
  kind,
  preferredRole,
  onAdd,
}: {
  label: string;
  kind: VideoReferencePickerRequest["kind"];
  preferredRole?: QuickCreateVideoReferenceRole;
  onAdd: Props["onAdd"];
}) {
  return (
    <button
      className="jimengReferenceTile empty"
      type="button"
      aria-label={`添加${label}`}
      onClick={() => onAdd({ kind, preferredRole })}
    >
      <Plus size={19} />
      <span>{label}</span>
    </button>
  );
}

function FilledReferenceTile({
  attachment,
  label,
  position,
  total,
  approved = false,
  onAdd,
  onRemove,
  onMove,
}: {
  attachment: AttachmentQueueItem;
  label: string;
  position: number;
  total: number;
  approved?: boolean;
  onAdd: Props["onAdd"];
  onRemove: Props["onRemove"];
  onMove: Props["onMove"];
}) {
  return (
    <article className="jimengReferenceTile filled" aria-label={`${label}：${attachment.name}`}>
      <ReferencePreview attachment={attachment} />
      {approved ? <span className="jimengReferenceApproval"><PortraitAdmissionIndicator name={attachment.name} approved /></span> : null}
      <button
        className="jimengReferenceReplace"
        type="button"
        aria-label={`替换${label}`}
        onClick={() => onAdd({
          kind: attachmentKind(attachment),
          replaceClientId: attachment.clientId,
        })}
      >
        <span>{label}</span>
        <small title={attachment.error || attachmentStateText(attachment)}>{attachment.state === "failed" ? "上传失败" : attachmentStateText(attachment)}</small>
        {attachmentTransferredText(attachment) ? <small>{attachmentTransferredText(attachment)}</small> : null}
      </button>
      <AttachmentUploadProgress attachment={attachment} />
      <span className="jimengReferenceTileActions">
        {total > 1 ? (
          <button
            type="button"
            aria-label={`${label}前移`}
            disabled={position === 0}
            onClick={() => onMove(attachment.clientId, -1)}
          >
            <ArrowLeft size={12} />
          </button>
        ) : null}
        {total > 1 ? (
          <button
            type="button"
            aria-label={`${label}后移`}
            disabled={position === total - 1}
            onClick={() => onMove(attachment.clientId, 1)}
          >
            <ArrowRight size={12} />
          </button>
        ) : null}
        <button type="button" aria-label={`移除${label}`} onClick={() => onRemove(attachment.clientId)}>
          <X size={12} />
        </button>
      </span>
    </article>
  );
}

function fixedRoleItem(
  attachments: AttachmentQueueItem[],
  assignments: Props["assignments"],
  role: QuickCreateVideoReferenceRole,
  excludedClientIds: Set<string> = new Set(),
) {
  return attachments.find((attachment) => (
    !excludedClientIds.has(attachment.clientId)
    && assignments[attachment.clientId]?.preferredRole === role
  ))
    || attachments.find((attachment) => (
      !excludedClientIds.has(attachment.clientId)
      && !assignments[attachment.clientId]?.preferredRole
    ))
    || null;
}

export default function VideoReferenceComposer({
  mode,
  attachments,
  assignments,
  maxItems,
  capacity,
  approvedAssetVersionIds = [],
  onAdd,
  onRemove,
  onMove,
}: Props) {
  const ordered = [...attachments].sort((left, right) => (
    (assignments[left.clientId]?.order ?? attachments.indexOf(left))
    - (assignments[right.clientId]?.order ?? attachments.indexOf(right))
  ));

  if (mode === "text_to_video" || mode === "standard" || !mode) return null;

  if (mode === "first_last_frame") {
    const first = fixedRoleItem(ordered, assignments, "first_frame");
    const last = fixedRoleItem(
      ordered,
      assignments,
      "last_frame",
      new Set(first ? [first.clientId] : []),
    );
    return (
      <div className="jimengReferenceRail fixedFrames" data-video-reference-mode={mode}>
        {first ? (
          <FilledReferenceTile
            attachment={first}
            approved={approvedAssetVersionIds.includes(Number(first.asset?.assetVersionId))}
            label="首帧"
            position={0}
            total={1}
            onAdd={(request) => onAdd({ ...request, preferredRole: "first_frame" })}
            onRemove={onRemove}
            onMove={onMove}
          />
        ) : (
          <EmptyReferenceTile label="首帧" kind="image" preferredRole="first_frame" onAdd={onAdd} />
        )}
        <ArrowLeftRight className="jimengReferenceSwapMark" size={16} aria-hidden="true" />
        {last ? (
          <FilledReferenceTile
            attachment={last}
            approved={approvedAssetVersionIds.includes(Number(last.asset?.assetVersionId))}
            label="尾帧"
            position={0}
            total={1}
            onAdd={(request) => onAdd({ ...request, preferredRole: "last_frame" })}
            onRemove={onRemove}
            onMove={onMove}
          />
        ) : (
          <EmptyReferenceTile label="尾帧" kind="image" preferredRole="last_frame" onAdd={onAdd} />
        )}
      </div>
    );
  }

  if (mode === "image_to_video") {
    const first = fixedRoleItem(ordered, assignments, "first_frame");
    return (
      <div className="jimengReferenceRail singleReference" data-video-reference-mode={mode}>
        {first ? (
          <FilledReferenceTile
            attachment={first}
            approved={approvedAssetVersionIds.includes(Number(first.asset?.assetVersionId))}
            label="首帧"
            position={0}
            total={1}
            onAdd={(request) => onAdd({ ...request, preferredRole: "first_frame" })}
            onRemove={onRemove}
            onMove={onMove}
          />
        ) : (
          <EmptyReferenceTile label="首帧" kind="image" preferredRole="first_frame" onAdd={onAdd} />
        )}
      </div>
    );
  }

  const isMultiFrame = mode === "image_reference" || mode === "reference_to_video";
  const isSourceVideo = mode === "video_edit" || mode === "video_extension";
  const tileKind: VideoReferencePickerRequest["kind"] = isMultiFrame
    ? "image"
    : isSourceVideo
      ? "video"
      : "mixed";
  const labelForIndex = (index: number) => (
    isMultiFrame
      ? `第${index + 1}帧`
      : isSourceVideo
        ? mode === "video_extension" ? "待续写视频" : "原视频"
        : `参考${index + 1}`
  );

  return (
    <div
      className={`jimengReferenceRail ${isMultiFrame ? "multiFrames" : isSourceVideo ? "sourceVideo" : "omniReferences"}`}
      data-video-reference-mode={mode}
      aria-label={isMultiFrame ? "智能多帧参考" : isSourceVideo ? "源视频" : "全能参考素材"}
    >
      {ordered.map((attachment, index) => (
        <FilledReferenceTile
          key={attachment.clientId}
          attachment={attachment}
          approved={approvedAssetVersionIds.includes(Number(attachment.asset?.assetVersionId))}
          label={labelForIndex(index)}
          position={index}
          total={ordered.length}
          onAdd={onAdd}
          onRemove={onRemove}
          onMove={onMove}
        />
      ))}
      {ordered.length < Math.max(1, maxItems) ? (
        <EmptyReferenceTile
          label={labelForIndex(ordered.length)}
          kind={tileKind}
          onAdd={(request) => onAdd({ ...request, multiple: !isSourceVideo })}
        />
      ) : null}
      {mode === "omni_reference" && capacity ? (
        <span className="jimengReferenceCapacity" role="status">
          <strong>已添加 {capacity.total.used}/{capacity.total.max}</strong>
          {capacity.image.max ? <small>图片 {capacity.image.used}/{capacity.image.max}</small> : null}
          {capacity.video.max ? <small>视频 {capacity.video.used}/{capacity.video.max}</small> : null}
          {capacity.file.max ? <small>音频 {capacity.file.used}/{capacity.file.max}</small> : null}
        </span>
      ) : !ordered.length && mode === "omni_reference" ? (
        <span className="jimengReferenceHint">
          <ImageIcon size={14} /> 支持图片、视频与音频
        </span>
      ) : null}
    </div>
  );
}
