import { createCanvasMediaActionBindings } from "./canvasMediaActionBindings";
import {
  useCanvasComposeFullscreen,
  useCanvasComposePlaybackEvents,
  useCanvasComposePreviewSync,
  useCanvasComposeTimelineDrag,
} from "./useCanvasComposePlayback";
import { useCanvasComposeState } from "./useCanvasComposeState";
import { useCanvasComposeView } from "./useCanvasComposeView";
import { useCanvasImageEditorState } from "./useCanvasImageEditorState";
import {
  useCanvasImageCropDrag,
  useCanvasImageOutpaintDrag,
  useCanvasVideoEraseRegionDrag,
  useCanvasVideoTrimDrag,
  useCanvasVideoTrimLoop,
  useCanvasVideoTrimPreview,
} from "./useCanvasMediaEditorInteractions";
import { useCanvasRuntimeRefs } from "./useCanvasRuntimeRefs";
import { useCanvasVideoEditorState } from "./useCanvasVideoEditorState";
export function useCanvasMediaPlaybackEffects({
  canvasRuntimeRefsModule,
  nodeMap,
  canvasComposeViewModule,
  canvasComposeStateModule,
  canvasMediaActionBindings,
  canvasVideoEditorStateModule,
  canvasImageEditorStateModule,
}: {
  canvasRuntimeRefsModule: ReturnType<typeof useCanvasRuntimeRefs>;
  nodeMap: Map<string, import("@/pages/fjtv/canvasDataTypes").NodeData>;
  canvasComposeViewModule: ReturnType<typeof useCanvasComposeView>;
  canvasComposeStateModule: ReturnType<typeof useCanvasComposeState>;
  canvasMediaActionBindings: ReturnType<typeof createCanvasMediaActionBindings>;
  canvasVideoEditorStateModule: ReturnType<typeof useCanvasVideoEditorState>;
  canvasImageEditorStateModule: ReturnType<typeof useCanvasImageEditorState>;
}) {
  useCanvasComposePreviewSync(
    () => ({
      composePreviewRef: canvasRuntimeRefsModule.composePreviewRef,
      composeActiveClip: canvasComposeViewModule.composeActiveClip,
      composeCurrentTime: canvasComposeStateModule.composeCurrentTime,
      composeMuted: canvasComposeStateModule.composeMuted,
      composePlaying: canvasComposeStateModule.composePlaying,
    }),
    [
      canvasComposeViewModule.composeActiveClip,
      canvasComposeStateModule.composeCurrentTime,
      canvasComposeStateModule.composeMuted,
      canvasComposeStateModule.composePlaying,
    ],
  );
  useCanvasComposePlaybackEvents(
    () => ({
      composePreviewRef: canvasRuntimeRefsModule.composePreviewRef,
      composeActiveClip: canvasComposeViewModule.composeActiveClip,
      composeClips: canvasComposeStateModule.composeClips,
      setComposePlaying: canvasComposeStateModule.setComposePlaying,
      setComposeCurrentTime: canvasComposeStateModule.setComposeCurrentTime,
      composeTotalDuration: canvasComposeViewModule.composeTotalDuration,
    }),
    [
      canvasComposeViewModule.composeActiveClip,
      canvasComposeStateModule.composeClips,
      canvasComposeViewModule.composeTotalDuration,
    ],
  );
  useCanvasComposeFullscreen(
    () => ({
      setComposePreviewFullscreen:
        canvasComposeStateModule.setComposePreviewFullscreen,
    }),
    [],
  );
  useCanvasComposeTimelineDrag(
    () => ({
      composeTimelineDragging: canvasComposeStateModule.composeTimelineDragging,
      composeTimelineRef: canvasRuntimeRefsModule.composeTimelineRef,
      seekComposeTime: canvasMediaActionBindings.seekComposeTime,
      composeTotalDuration: canvasComposeViewModule.composeTotalDuration,
      setComposeTimelineDragging:
        canvasComposeStateModule.setComposeTimelineDragging,
    }),
    [
      canvasComposeStateModule.composeTimelineDragging,
      canvasComposeViewModule.composeTotalDuration,
      canvasComposeStateModule.composePlaying,
      canvasComposeStateModule.composeClips,
    ],
  );
  useCanvasVideoTrimLoop(
    () => ({
      activeVideoEditor: canvasVideoEditorStateModule.activeVideoEditor,
      videoTrimDraft: canvasVideoEditorStateModule.videoTrimDraft,
      nodeVideoRefs: canvasRuntimeRefsModule.nodeVideoRefs,
    }),
    [
      canvasVideoEditorStateModule.activeVideoEditor,
      canvasVideoEditorStateModule.videoTrimDraft,
    ],
  );
  useCanvasVideoTrimDrag(
    () => ({
      videoTrimDragging: canvasVideoEditorStateModule.videoTrimDragging,
      activeVideoEditor: canvasVideoEditorStateModule.activeVideoEditor,
      videoTrimDraft: canvasVideoEditorStateModule.videoTrimDraft,
      nodeMap,
      applyTrimSnap: canvasMediaActionBindings.applyTrimSnap,
      setVideoTrimDraft: canvasVideoEditorStateModule.setVideoTrimDraft,
      setVideoTrimDragging: canvasVideoEditorStateModule.setVideoTrimDragging,
    }),
    [
      canvasVideoEditorStateModule.activeVideoEditor,
      nodeMap,
      canvasVideoEditorStateModule.videoTrimDragging,
      canvasVideoEditorStateModule.videoTrimDraft,
    ],
  );
  useCanvasVideoEraseRegionDrag(
    () => ({
      videoCropDragging: canvasVideoEditorStateModule.videoCropDragging,
      activeVideoEditor: canvasVideoEditorStateModule.activeVideoEditor,
      videoCropDraft: canvasVideoEditorStateModule.videoCropDraft,
      nodeMap,
      setVideoCropDraft: canvasVideoEditorStateModule.setVideoCropDraft,
      setVideoCropDragging: canvasVideoEditorStateModule.setVideoCropDragging,
    }),
    [
      canvasVideoEditorStateModule.activeVideoEditor,
      nodeMap,
      canvasVideoEditorStateModule.videoCropDragging,
      canvasVideoEditorStateModule.videoCropDraft,
    ],
  );
  useCanvasImageOutpaintDrag(
    () => ({
      imageOutpaintDragging: canvasImageEditorStateModule.imageOutpaintDragging,
      activeImageOutpaint: canvasImageEditorStateModule.activeImageOutpaint,
      nodeMap,
      setActiveImageOutpaint:
        canvasImageEditorStateModule.setActiveImageOutpaint,
      setImageOutpaintDragging:
        canvasImageEditorStateModule.setImageOutpaintDragging,
    }),
    [
      canvasImageEditorStateModule.activeImageOutpaint,
      canvasImageEditorStateModule.imageOutpaintDragging,
      nodeMap,
    ],
  );
  useCanvasImageCropDrag(
    () => ({
      imageCropDragging: canvasImageEditorStateModule.imageCropDragging,
      activeImageCrop: canvasImageEditorStateModule.activeImageCrop,
      nodeMap,
      setActiveImageCrop: canvasImageEditorStateModule.setActiveImageCrop,
      setImageCropDragging: canvasImageEditorStateModule.setImageCropDragging,
    }),
    [
      canvasImageEditorStateModule.activeImageCrop,
      canvasImageEditorStateModule.imageCropDragging,
      nodeMap,
    ],
  );
  useCanvasVideoTrimPreview(
    () => ({
      activeVideoEditor: canvasVideoEditorStateModule.activeVideoEditor,
      videoTrimDraft: canvasVideoEditorStateModule.videoTrimDraft,
      nodeVideoRefs: canvasRuntimeRefsModule.nodeVideoRefs,
    }),
    [
      canvasVideoEditorStateModule.activeVideoEditor,
      canvasVideoEditorStateModule.videoTrimDraft,
    ],
  );
}
