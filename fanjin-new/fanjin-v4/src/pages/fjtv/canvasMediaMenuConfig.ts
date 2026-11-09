import type { RatioKey } from "./canvasMediaTypes";
import type { StoryboardStitchResolution } from "./canvasDataTypes";
export const IMAGE_GRID_PRESETS = [
  { key: "2x2", rows: 2, cols: 2, label: "4宫格 (2x2)" },
  { key: "3x3", rows: 3, cols: 3, label: "9宫格 (3x3)" },
  { key: "4x4", rows: 4, cols: 4, label: "16宫格 (4x4)" },
  { key: "5x5", rows: 5, cols: 5, label: "25宫格 (5x5)" },
] as const;
export const STORYBOARD_RATIO_ITEMS: RatioKey[] = ["16:9", "4:3", "1:1", "3:4"];
export const STORYBOARD_STITCH_RESOLUTIONS: StoryboardStitchResolution[] = ["2k", "4k"];
export const IMAGE_GRID_CUSTOM_MAX = 5;
export const IMAGE_NINE_GRID_MENU_ITEMS = [
  { key: "multi-angle-nine-grid", label: "多机位九宫格", icon: "grid" },
  { key: "story-four-grid", label: "剧情推演四宫格", icon: "grid" },
  { key: "face-three-view", label: "角色脸部三视图", icon: "portrait" },
  { key: "character-sheet", label: "角色设定图", icon: "person" },
  { key: "scene-sheet", label: "场景设定图", icon: "scene" },
  { key: "product-sheet", label: "产品设定图", icon: "product" },
  { key: "storyboard-25-grid", label: "25宫格连贯分镜", icon: "grid" },
  { key: "cinematic-lighting", label: "电影级光影校正", icon: "film" },
  { key: "character-three-view", label: "角色三视图", icon: "person" },
  { key: "frame-forward-3s", label: "画面推演 - 3秒后", icon: "time" },
  { key: "frame-backward-5s", label: "画面推演 - 5秒前", icon: "time" },
] as const;
export const OPEN_IMAGE_NINE_GRID_MENU_ITEMS = IMAGE_NINE_GRID_MENU_ITEMS.filter(
  (item) => !["story-four-grid", "frame-forward-3s", "frame-backward-5s"].includes(item.key),
);
export const IMAGE_HD_MENU_ITEMS = [
  { key: "enhance", label: "高清" },
  { key: "outpaint", label: "扩图" },
  { key: "redraw", label: "重绘" },
  { key: "erase", label: "擦除" },
  { key: "remove-bg", label: "抠图" },
  { key: "crop", label: "裁剪" },
] as const;
export const OPEN_IMAGE_HD_MENU_ITEMS = IMAGE_HD_MENU_ITEMS.filter((item) => item.key === "crop");
export const IMAGE_TRANSFORM_MENU_ITEMS = [
  { key: "transform", label: "图片变换" },
  { key: "remove-bg", label: "图像背景移除" },
  { key: "erase-repair", label: "图像擦除修复" },
  { key: "rotate-mirror", label: "旋转与镜像" },
] as const;
export const OPEN_IMAGE_TRANSFORM_MENU_ITEMS = IMAGE_TRANSFORM_MENU_ITEMS.filter(
  (item) => item.key === "transform" || item.key === "rotate-mirror",
);
