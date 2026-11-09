// 领域类型：从旧 Vue (fanjin-web) 的 stores/user.ts、stores/project.ts、views/assets 迁移。
// 只保留 React V4 冲刺需要的最小字段，保持与后端线格式一致。

export type AuthRole =
  | "user"
  | "root"
  | "admin"
  | "super_admin"
  | "finance_viewer"
  | "finance_operator"
  | "finance_manager"
  | "owner"
  | "workspace_admin"
  | "developer"
  | "creator"
  | "viewer"
  | "billing"
  | "member";

export type User = {
  id: string | number;
  name: string;
  /** Preferred public label from /auth/me (`displayName`). */
  displayName?: string | null;
  email?: string;
  avatar?: string;
  role?: AuthRole | string;
  roles?: string[];
  enterpriseId?: string | number;
};

export type WorkspacePlan = "free" | "team" | "enterprise" | string;
export type WorkspaceStatus = "active" | "trialing" | "suspended" | string;

export type Workspace = {
  id: string | number;
  name: string;
  slug?: string;
  plan?: WorkspacePlan;
  status?: WorkspaceStatus;
  region?: string;
  role?: AuthRole | string;
  memberRole?: AuthRole | string;
  /** 当前会话工作区的后端有效权限；存在时是权威 allow-list。 */
  permissions?: string[];
  /** 工作区列表中的成员自定义权限原值，仅用于展示；不要直接当作有效权限。 */
  memberPermissions?: string[];
  memberCount?: number;
  apiQuota?: number;
  apiUsed?: number;
  ownerUserId?: string | number;
  createdAt?: number | string;
  updatedAt?: number | string;
};

/** `/auth/me`、登录、workspace 切换等接口共用的会话结构。 */
export type AuthSession = {
  user: User | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  /** `/auth/me` 为当前工作区计算出的有效权限。 */
  permissions?: string[];
  platformAccess?: {
    role: AuthRole | string | null;
    effectivePermissions: string[];
  };
};

export type Project = {
  id: string | number;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  videoRatio: string | null;
  /** Canonical `/projects` cover shared with the canvas project browser. */
  coverImageUrl?: string;
  createTime?: number;
  updatedAt?: number;
  imageModel?: string;
  videoModel?: string;
  projectType?: string;
  /** Anonymous, server-keyed project correlation; never a raw project ID. */
  correlationDigest?: string | null;
  imageQuality?: "1K" | "2K" | "4K" | "";
  mode?: string;
  directorManual?: string;
};

/** 资产/主体分类。role=角色(主体)、tool=道具、scene=场景、clip=素材、audio=音频。 */
export type AssetType =
  | "role"
  | "tool"
  | "scene"
  | "clip"
  | "audio"
  | "image"
  | "video"
  | "document";

export type Asset = {
  id: number;
  /** Owning project returned by `o_assets`; required for catalog isolation. */
  projectId?: number | string | null;
  assetsId?: number | null;
  name: string;
  prompt?: string;
  describe?: string;
  remark?: string;
  src?: string;
  type: AssetType;
  state?: string;
  imageId?: number;
  startTime?: number | string;
  promptState?: string;
  filePath?: string;
  /** Persistent asset metadata tags, including internal fanjin usage/group tags. */
  tags?: string[];
  sonAssets?: Asset[];
};

export type Paginated<T> = {
  data: T[];
  total: number;
};
