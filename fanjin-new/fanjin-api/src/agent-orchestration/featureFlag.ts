/**
 * FANJIN_AGENT_USE_CORE：是否用 core-backed executor 替换 toolLoopProcessor 这一路。
 * 默认 0（关闭）。关闭时行为与重构前逐字节一致。
 *
 * 重要：与现有 FANJIN_AGENT_TOOLS_ENABLED 是正交的。
 *  - TOOLS_ENABLED 决定 Run 是否走 toolsEnabled 路径（admission）。
 *  - USE_CORE 决定「走 tools 路径的 Run」用旧 processor 还是 core-backed。
 * 两者都为真才启用 core 跑工具 Run。
 * 
 * 灰度策略：
 *  - "1": 全局启用
 *  - "0" 或未设置: 全局禁用
 *  - "workspace:ws_xxx": 仅为指定 workspace 启用
 *  - "project:123": 仅为指定 project 启用
 *  - "percent:10": 按 workspace ID 哈希的 10% 启用
 */

const AGENT_USE_CORE_ENV = "FANJIN_AGENT_USE_CORE";

/**
 * 检查是否启用 core-backed executor（全局级别）。
 * 仅当环境变量严格等于 "1" 时为真；其余（含未设置）为假。
 */
export function isAgentCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[AGENT_USE_CORE_ENV] || "").trim() === "1";
}

/**
 * 检查指定 workspace/project 是否启用 core-backed executor（细粒度灰度）。
 * 
 * @param workspaceId - workspace ID
 * @param projectId - project ID
 * @param env - 环境变量（默认 process.env）
 * @returns 是否启用
 */
export function shouldUseCoreBackedProcessor(
  workspaceId: string,
  projectId: number,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = String(env[AGENT_USE_CORE_ENV] || "").trim();
  
  // 全局启用
  if (flag === "1") return true;
  
  // 全局禁用
  if (!flag || flag === "0") return false;
  
  // workspace 级别
  if (flag.startsWith("workspace:")) {
    const targetWorkspace = flag.slice("workspace:".length);
    return workspaceId === targetWorkspace;
  }
  
  // project 级别
  if (flag.startsWith("project:")) {
    const targetProject = parseInt(flag.slice("project:".length), 10);
    return projectId === targetProject;
  }
  
  // 百分比灰度（基于 workspace ID 哈希）
  if (flag.startsWith("percent:")) {
    const percent = parseInt(flag.slice("percent:".length), 10);
    if (isNaN(percent) || percent < 0 || percent > 100) return false;
    
    // 简单哈希：workspace ID 的字符码之和模 100
    let hash = 0;
    for (let i = 0; i < workspaceId.length; i++) {
      hash = (hash + workspaceId.charCodeAt(i)) % 100;
    }
    return hash < percent;
  }
  
  // 未知格式，默认禁用
  return false;
}
