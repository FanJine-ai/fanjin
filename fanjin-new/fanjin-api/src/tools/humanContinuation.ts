import { z } from "zod";

// These operations require a real browser session or identity verification.
// A scoped creative API key must never fabricate that session or receive OTPs.
export const humanActions = {
  account_security: { title: "修改密码、绑定邮箱和二次验证", path: "/settings/profile/security" },
  identity_verification: { title: "真人身份与授权核验", path: "/settings/profile/authentication" },
  api_keys: { title: "创建、轮换或撤销 API 密钥", path: "/developer/api/keys" },
  workspace_select: { title: "创建或切换工作区", path: "/workspace/select" },
  workspace_members: { title: "邀请成员、权限变更和停用", path: "/workspace/members" },
  workspace_owner: { title: "工作区所有者转移", path: "/workspace/manage" },
  billing_request: { title: "付款及服务申请身份确认", path: "/workspace/billing" },
  release: { title: "在原发布控制台执行签名制品发布", path: null },
} as const;
export const humanContinuationTool = {
  fanjin_human_continue: {
    title: "获取需要本人完成的操作入口",
    description: "为密码、真人核验、密钥管理、成员权限、付款和发布返回接续指引。不会执行操作，不索取密码或验证码。业务读取和创作请直接用 MCP。发布沿用独立控制台的签名制品、授权、租约与回滚流程。",
    keyPermission: null, memberPermission: "workspace:read", readOnly: true,
    schema: z.strictObject({ action: z.enum(Object.keys(humanActions) as [keyof typeof humanActions, ...Array<keyof typeof humanActions>]) }),
  },
} as const;
export function humanContinuation(action: keyof typeof humanActions) {
  const entry = humanActions[action];
  return { action, ...entry, executed: false, requiresHuman: true,
    ...(entry.path ? { relativeUrl: `/#${entry.path}`, instruction: "在当前繁境服务打开此路径，由本人完成核验。已有 MCP 密钥仍绑定原工作区。" }
      : { instruction: "打开繁境原发布控制台，选择候选并完成测试、授权与发布；普通创作密钥不能替代发布主体。" }) };
}
