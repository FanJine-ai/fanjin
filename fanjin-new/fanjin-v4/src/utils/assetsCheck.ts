// assetsCheck.ts — migrated from fanjin-web.
// Original used Vue render() + TDesign Dialog for an imperative asset selector.
// In React, export the types + interface only. Implement as a React modal component
// that returns a Promise<Asset[]> (see TODO below for full component migration).

export interface Asset {
  id: number;
  assetsId: number | null;
  name: string;
  prompt: string;
  describe: string;
  remark: string;
  src: string;
  type: "role" | "tool" | "scene" | "clip" | "audio";
  imageId: number | null;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  sonAssets?: Asset[];
}

export type AssetType = "role" | "tool" | "scene" | "clip" | "audio";
export type ClipMediaType = "image" | "video" | "audio";

export interface AssetsSelectOptions {
  /** 限制显示的资产类型，不传则显示全部 */
  types?: AssetType[];
  /** 当 types 包含 clip 时，限制 clip 的媒体子类型（图片/视频/音频），不传则显示全部 */
  clipMediaTypes?: ClipMediaType[];
  /** 是否多选，默认 true */
  multiple?: boolean;
  /** 弹窗标题 */
  title?: string;
  selectorMode?: boolean;
}

/**
 * TODO: Implement as a React component that renders an asset selection modal.
 * Usage pattern in React:
 *
 *   const { open } = useAssetsSelector();
 *   const assets = await open({ types: ["role", "scene"] });
 *
 * Or use a state-based modal:
 *
 *   const [selectorOpen, setSelectorOpen] = useState(false);
 *   <AssetsSelectorModal
 *     open={selectorOpen}
 *     onClose={(assets) => { setSelectorOpen(false); /* handle assets *\/ }}
 *     options={{ types: ["role"] }}
 *   />
 */
export default function openAssetsSelector(_options: AssetsSelectOptions = {}): Promise<Asset[]> {
  console.warn("[assetsCheck] openAssetsSelector is a stub in React — implement as a React modal component.");
  return Promise.resolve([]);
}
