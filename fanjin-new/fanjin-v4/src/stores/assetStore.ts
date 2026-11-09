// assetStore：资产/主体库状态，从旧 Vue src/views/assets 迁移。
// "主体" 是 type === "role" 的资产子集。
import { create } from "zustand";
import type { ApiErrorView } from "../api/http";
import { toApiErrorView } from "../api/http";
import * as assetsApi from "../api/assets";
import type { Asset, AssetType } from "../api/types";
import type { AssetLibraryItem, AssetLibraryView } from "../api/assets";
import type { ProjectAssetCatalogItem } from "../features/assets/assetCatalog";
import { normalizeProjectId, useProjectStore } from "./projectStore";

type AssetState = {
  assets: Asset[];
  /** Canonical project-scoped directory shared by Agent and the canvas. */
  catalog: ProjectAssetCatalogItem[];
  catalogProjectId: number | null;
  subjects: Asset[]; // type === "role" 的子集
  libraryAssets: AssetLibraryItem[];
  libraryView: AssetLibraryView;
  libraryLoading: boolean;
  libraryError: ApiErrorView | null;
  loading: boolean;
  error: ApiErrorView | null;

  fetchAssets: (params?: { type?: string; page?: number; limit?: number }) => Promise<void>;
  fetchLibraryAssets: (params?: { view?: AssetLibraryView; type?: AssetType; name?: string; page?: number; limit?: number }) => Promise<void>;
  addLibraryAssetToProject: (asset: AssetLibraryItem) => Promise<void>;
  removeLibraryAssetFromProject: (asset: AssetLibraryItem) => Promise<void>;
  shareLibraryAssetWithWorkspace: (asset: AssetLibraryItem) => Promise<void>;
  shareLibraryAssetWithMember: (asset: AssetLibraryItem, userId: number) => Promise<void>;
  transferLibraryAssetToWorkspace: (asset: AssetLibraryItem) => Promise<void>;
  uploadAsset: (file: File) => Promise<Asset>;
  deleteAsset: (id: number) => Promise<void>;
};

/** 把 assets 里的 role 类型筛出来当主体列表。 */
function filterSubjects(assets: Asset[]): Asset[] {
  return assets.filter((a) => a.type === "role");
}

const assetTypes: AssetType[] = ["role", "tool", "scene", "clip", "audio", "image", "video"];

let fetchRequestId = 0;

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const useAssetStore = create<AssetState>()((set, get) => ({
  assets: [],
  catalog: [],
  catalogProjectId: null,
  subjects: [],
  libraryAssets: [],
  libraryView: "all",
  libraryLoading: false,
  libraryError: null,
  loading: false,
  error: null,

  fetchAssets: async (params) => {
    const projectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
    if (projectId === null) {
      fetchRequestId += 1;
      set({ assets: [], catalog: [], catalogProjectId: null, subjects: [], error: { message: "请先选择项目" } });
      return;
    }
    const requestId = ++fetchRequestId;
    set({ loading: true, error: null });
    try {
      const types = params?.type ? [params.type as AssetType] : assetTypes;
      const result = await assetsApi.listProjectAssetCatalog({
        projectId,
        types,
        pageSize: params?.limit ?? 100,
      });
      if (
        requestId !== fetchRequestId
        || normalizeProjectId(useProjectStore.getState().currentProjectId) !== projectId
      ) return;
      set({
        assets: result.assets,
        catalog: result.items,
        catalogProjectId: projectId,
        subjects: filterSubjects(result.assets),
      });
    } catch (e) {
      if (
        requestId === fetchRequestId
        && normalizeProjectId(useProjectStore.getState().currentProjectId) === projectId
      ) set({ error: toApiErrorView(e) });
    } finally {
      if (requestId === fetchRequestId) set({ loading: false });
    }
  },

  fetchLibraryAssets: async (params) => {
    const projectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
    const view = params?.view || get().libraryView;
    set({ libraryLoading: true, libraryError: null, libraryView: view });
    try {
      const result = await assetsApi.listAssetLibrary({
        view,
        ...(projectId !== null ? { projectId } : {}),
        type: params?.type,
        name: params?.name,
        page: params?.page,
        limit: params?.limit ?? 100,
      });
      set({ libraryAssets: result.items, libraryView: result.view });
    } catch (error) {
      set({ libraryAssets: [], libraryError: toApiErrorView(error) });
    } finally {
      set({ libraryLoading: false });
    }
  },

  addLibraryAssetToProject: async (asset) => {
    const projectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
    if (projectId === null) throw new Error("请先选择项目");
    if (!asset.permissions.use) throw new Error("当前账号无权在项目中使用该资产");
    await assetsApi.addAssetToProject({
      projectId,
      assetId: asset.id,
      ...(asset.imageId ? { assetVersionId: `image:${asset.imageId}` } : {}),
      expectedOwnershipRevision: asset.ownership.revision,
    });
    await Promise.all([
      get().fetchAssets(),
      get().fetchLibraryAssets({ view: get().libraryView }),
    ]);
  },

  removeLibraryAssetFromProject: async (asset) => {
    const projectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
    if (projectId === null) throw new Error("请先选择项目");
    if (!asset.projectReference) throw new Error("该资产尚未加入当前项目");
    await assetsApi.removeAssetFromProject({
      projectId,
      refId: asset.projectReference.id,
      expectedRevision: asset.projectReference.revision,
    });
    await Promise.all([
      get().fetchAssets(),
      get().fetchLibraryAssets({ view: get().libraryView }),
    ]);
  },

  shareLibraryAssetWithWorkspace: async (asset) => {
    if (!asset.permissions.manage) throw new Error("当前账号无权分享该资产");
    await assetsApi.shareAsset({
      assetId: asset.id,
      granteeType: "workspace",
      canView: true,
      canUse: true,
      canManage: false,
      expectedOwnershipRevision: asset.ownership.revision,
    });
    await get().fetchLibraryAssets({ view: get().libraryView });
  },

  shareLibraryAssetWithMember: async (asset, userId) => {
    if (!asset.permissions.manage) throw new Error("当前账号无权分享该资产");
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("请选择有效的工作区成员");
    await assetsApi.shareAsset({
      assetId: asset.id,
      granteeType: "user",
      granteeUserId: userId,
      canView: true,
      canUse: true,
      canManage: false,
      expectedOwnershipRevision: asset.ownership.revision,
    });
    await get().fetchLibraryAssets({ view: get().libraryView });
  },

  transferLibraryAssetToWorkspace: async (asset) => {
    if (asset.ownership.ownerType !== "user" || asset.authority !== "owner") {
      throw new Error("只有账号资产所有者可以转为工作区资产");
    }
    await assetsApi.transferAssetToWorkspace({
      assetId: asset.id,
      expectedRevision: asset.ownership.revision,
    });
    await Promise.all([
      get().fetchAssets(),
      get().fetchLibraryAssets({ view: "workspace" }),
    ]);
  },

  /**
   * uploadAsset：读取文件为 base64，调 /assets/uploadClip。
   * 这是 Codex 快速创作 `@ 主体` 面板需要的核心接口。
   */
  uploadAsset: async (file: File) => {
    const projectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
    if (projectId === null) {
      throw new Error("请先选择项目");
    }
    set({ loading: true, error: null });
    try {
      const base64Data = await fileToDataUrl(file);
      const asset = await assetsApi.uploadClip({
        projectId,
        base64Data,
        name: file.name,
      });
      // 上传成功后刷新列表
      await get().fetchAssets();
      return asset;
    } catch (e) {
      set({ error: toApiErrorView(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  },

  deleteAsset: async (id) => {
    set({ loading: true, error: null });
    try {
      await assetsApi.deleteAsset(id);
      // 删除成功后刷新列表
      await get().fetchAssets();
    } catch (e) {
      set({ error: toApiErrorView(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  },
}));

let observedProjectId = normalizeProjectId(useProjectStore.getState().currentProjectId);
useProjectStore.subscribe((state) => {
  const nextProjectId = normalizeProjectId(state.currentProjectId);
  if (nextProjectId === observedProjectId) return;
  observedProjectId = nextProjectId;
  fetchRequestId += 1;
  // Never expose the previous project's assets while the new project loads.
  useAssetStore.setState({
    assets: [],
    catalog: [],
    catalogProjectId: null,
    subjects: [],
    libraryAssets: [],
    libraryView: "all",
    libraryLoading: false,
    libraryError: null,
    loading: false,
    error: null,
  });
});
