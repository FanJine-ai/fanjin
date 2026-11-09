import type { ProductScriptAssetKind, RatioPanelItem } from "./canvasDataTypes";
import type { NodeType } from "./canvasMediaTypes";
import { isCanvasNodeCreationOpen } from "./canvasGraphPolicy";
import { FileImage, FileText, Film, Layers3, Music4, Sparkles, Video } from "lucide-react";

export const LAST_ACTIVE_CANVAS_KEY = "infinite_canvas_last_active_canvas_id";

export const CANVAS_ASSET_DRAG_MIME = "application/x-fanjin-canvas-asset";

export const STUDIO_PROJECT_HEADER_SLOT_ID = "project-studio-project-header-slot";

export const GENERATE_DEBUG_ENABLED = import.meta.env.DEV && import.meta.env.VITE_FJTV_GENERATE_DEBUG === "1";

export const CANVAS_VISUAL_SCALE = 1.25;

export const FIXED_UI_ZOOM = 1.16;

export const NODE_RADIUS = 12;

export const CONNECTION_DRAG_THRESHOLD = 6;

export const PROMPT_WIDTH = 900;

export const PROMPT_HEIGHT = 120;

export const PROMPT_EXPANDED_WIDTH = 960;

export const PROMPT_EXPANDED_HEIGHT = 600;

export const EDGE_HIT_TOLERANCE_PX = 12;

export const EDGE_ARM_DELAY_MS = 1000;

export const EDGE_SAMPLE_COUNT = 60;

export const EDGE_RECT_SAMPLE_COUNT = 80;

export const EDGE_FLOW_DASH = "10 18";

export const ALIGN_THRESHOLD_PX = 8;

export const CANVAS_WORKFLOW_TEMPLATES_SCHEMA_VERSION = 41;

export const WORKFLOW_STORAGE_KEY = "menghuiai_infinite_canvas_workflows_v2";

export const ASSET_STORAGE_KEY = "menghuiai_infinite_canvas_assets_v1";

export const GROUP_THEME_COLORS = ["#5a6576", "#8e4351", "#9a6334", "#8b7426", "#2e7a5d", "#1f7687", "#3f69cf", "#6d57c7"];

export const SELECTION_FRAME_PAD = 30;

export const GROUP_FRAME_PAD = 34;

export const PROMPT_PANEL_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif';

export const NODE_SELECTION_BORDER = "#d0d0d2";

export const NODE_SELECTION_GLOW = "0 0 0 1px rgba(255,255,255,0.72), 0 0 36px rgba(255,255,255,0.08)";

export const ASSET_SAVE_LOCATIONS = ["我的资产", "产品图库", "视频素材库", "其它"];

export const ASSET_TAGS = ["其它", "人物", "场景", "物品", "风格"];

export const ASSET_CATEGORY_FALLBACK = "其它";

export const PRODUCT_SCRIPT_ASSETS: Array<{ kind: ProductScriptAssetKind; label: string; placeholder: string }> = [
  { kind: "model", label: "模特图", placeholder: "上传或生成模特参考，用于人物动作和肤色妆效一致性" },
  { kind: "product", label: "产品图", placeholder: "上传清晰产品图，用于包装、颜色、质地和卖点解析" },
  { kind: "makeup", label: "上妆效果图", placeholder: "上传上妆效果图，用于解析妆效、质感和最终呈现" },
];

export const CREATION_MENU_ITEMS = [
  { key: "text", label: "文本", icon: FileText, kind: "node" as const, nodeType: "text" as NodeType },
  { key: "image", label: "图片", icon: FileImage, kind: "node" as const, nodeType: "image" as NodeType },
  { key: "video", label: "视频", icon: Film, kind: "node" as const, nodeType: "video" as NodeType },
  { key: "video-draft", label: "视频样片", icon: Film, kind: "action" as const },
  { key: "video-extend", label: "延长视频", icon: Film, kind: "action" as const },
  { key: "video-edit", label: "修改视频", icon: Sparkles, kind: "action" as const },
  { key: "compose", label: "视频合成", icon: Video, kind: "node" as const, nodeType: "compose" as NodeType },
  { key: "director", label: "导演台", icon: Layers3, kind: "action" as const, badge: "NEW" },
  { key: "audio", label: "音频", icon: Music4, kind: "node" as const, nodeType: "audio" as NodeType },
  { key: "material", label: "素材库", icon: Sparkles, kind: "action" as const, badge: "NEW" },
] as const;

export const OPEN_CREATION_MENU_ITEMS = CREATION_MENU_ITEMS.filter(
  (item) => item.kind === "node" ? isCanvasNodeCreationOpen(item.key) : item.key === "material" || item.key === "video-draft" || item.key === "video-extend" || item.key === "video-edit",
);

export const TEXT_TRY_ACTIONS = [
  { key: "write", label: "自己编写内容", icon: "text" as const },
  { key: "video", label: "文生视频", icon: "video" as const },
];

export const TEXT_BACKGROUND_SWATCHES = [
  { key: "none", color: "", bg: "#151515", ring: "#3f4044" },
  { key: "red", color: "#3a2020", bg: "#ef3f43", ring: "#ff5a62" },
  { key: "orange", color: "#3a2819", bg: "#ff9d21", ring: "#ffb14b" },
  { key: "yellow", color: "#3b3313", bg: "#ffc918", ring: "#ffe06a" },
  { key: "green", color: "#193522", bg: "#23d16d", ring: "#48ea8c" },
  { key: "cyan", color: "#143534", bg: "#14d2cc", ring: "#4af4ef" },
  { key: "blue", color: "#173048", bg: "#17aeea", ring: "#55d2ff" },
  { key: "purple", color: "#2d2050", bg: "#8b48ee", ring: "#aa77ff" },
  { key: "magenta", color: "#3a1646", bg: "#d900f0", ring: "#f05cff" },
  { key: "gray", color: "#303030", bg: "#747474", ring: "#929292" },
] as const;

export const TEXT_PRESET_VIDEO_PROMPT =
  "电影级人物镜头 雨夜街头，霓虹灯反射在湿漉漉的地面，女主撑伞站在路灯下，表情克制而坚定，镜头环绕人物360度缓慢移动，浅景深，光影对比强烈，电影级调色，真实皮肤质感";

export const VIDEO_TRY_ACTIONS = [
  { key: "firstLastFrame", label: "首尾帧生成视频", icon: "boxes" as const },
  { key: "firstFrame", label: "首帧生成视频", icon: "spark" as const },
];

export const RATIO_PANEL_ITEMS: RatioPanelItem[] = [
  { key: "auto", label: "自适应", glyphWidth: 10, glyphHeight: 10 },
  { key: "1:1", label: "1:1", glyphWidth: 10, glyphHeight: 10 },
  { key: "9:16", label: "9:16", glyphWidth: 8, glyphHeight: 14 },
  { key: "16:9", label: "16:9", glyphWidth: 14, glyphHeight: 8 },
  { key: "3:4", label: "3:4", glyphWidth: 9, glyphHeight: 12 },
  { key: "4:3", label: "4:3", glyphWidth: 12, glyphHeight: 9 },
  { key: "3:2", label: "3:2", glyphWidth: 12, glyphHeight: 8 },
  { key: "2:3", label: "2:3", glyphWidth: 8, glyphHeight: 12 },
  { key: "4:5", label: "4:5", glyphWidth: 9, glyphHeight: 11 },
  { key: "5:4", label: "5:4", glyphWidth: 11, glyphHeight: 9 },
  { key: "21:9", label: "21:9", glyphWidth: 16, glyphHeight: 7 },
  { key: "9:21", label: "9:21", glyphWidth: 7, glyphHeight: 16 },
];
