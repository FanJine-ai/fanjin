export type NodeType = "image" | "video" | "text" | "audio" | "compose" | "script";

export type RatioKey = "1:1" | "2:1" | "2:3" | "3:2" | "4:5" | "5:4" | "16:9" | "9:16" | "21:9" | "9:21" | "3:4" | "4:3" | "auto";

export type ImageOutpaintRatioMode = "original" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "custom";

export type ImageOutpaintResolution = "1K" | "2K" | "4K";

export interface ImageOutpaintDraft {
  nodeId: string;
  ratioMode: ImageOutpaintRatioMode;
  resolution: ImageOutpaintResolution;
  count: number;
  expandLeft: number;
  expandRight: number;
  expandTop: number;
  expandBottom: number;
}

export interface ImageCropDraft {
  nodeId: string;
  ratioMode: ImageOutpaintRatioMode;
  x: number;
  y: number;
  width: number;
  height: number;
}
