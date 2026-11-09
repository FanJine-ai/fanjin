const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get("token")) { sessionStorage.setItem("fanjin-update-token", fragment.get("token")); history.replaceState(null, "", location.pathname); }
const token = sessionStorage.getItem("fanjin-update-token");
const byId = id => document.getElementById(id);
const phases = { downloading: "正在下载，繁境仍可使用", verifying_package: "正在校验更新包", waiting_tasks: "正在保存任务并等待请求完成", backing_up: "正在备份数据", switching: "正在检查新版本", activating: "正在恢复创作服务", succeeded: "更新完成，可以返回繁境", rolled_back: "更新未完成，已恢复原版本", failed: "更新未完成", recovery_required: "恢复未完成，请查看本机更新记录" };
const errors = { LOCAL_UPDATE_AUTH_REQUIRED: "请从繁境后台或本机启动入口重新打开更新页面。", FEED_UNAVAILABLE: "暂时无法获取新版本，请稍后重试。", RELEASE_WITHDRAWN: "这个版本已暂停分发，请重新检查更新。", DATABASE_UPGRADE_ADAPTER_REQUIRED: "这个版本需要数据库迁移，目前的更新器暂不支持，请使用发布说明中的升级路径。", INTERMEDIATE_VERSION_REQUIRED: "需要先安装中间版本。", UPDATER_TOO_OLD: "请先升级本机更新器。", INSUFFICIENT_DISK: "本机空间不足，请释放空间后重试。", UPDATE_SELECTION_CHANGED: "版本信息已变化，请重新检查更新。" };
let state, busy = false;
async function request(action, input) {
  const response = await fetch(action, { method: input ? "POST" : "GET", cache: "no-store", headers: { authorization: "Bearer " + token, ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const value = await response.json(); if (!response.ok) throw Error(errors[value.code] || "操作未完成：" + value.code); return value;
}
function render(value) {
  state = value;
  byId("current").textContent = value.current?.version || "尚未安装";
  byId("available").textContent = value.available?.version || "暂无更新";
  byId("notes").textContent = value.available?.notes || "";
  const active = value.job && !["succeeded", "failed", "rolled_back"].includes(value.job.state);
  byId("progress").textContent = value.startupError ? "本机服务恢复未完成：" + value.startupError : value.job ? phases[value.job.state] || value.job.state : value.available ? "新版本已就绪" : "点击检查更新，获取最新版本";
  byId("apply").disabled = busy || active || !!value.startupError || !value.available;
  byId("check").disabled = busy || active;
  byId("recover").hidden = !value.startupError && value.job?.state !== "recovery_required";
  byId("recover").disabled = busy;
}
async function run(action, input) {
  busy = true; if (state) render(state); byId("error").textContent = "";
  try { render(await request(action, input)); } catch (error) { byId("error").textContent = error.message; }
  finally { busy = false; if (state) render(state); }
}
byId("check").onclick = () => run("check", {});
byId("apply").onclick = () => run("apply", { expectedDigest: state.availableDigest });
byId("recover").onclick = () => run("recover", {});
await run("status");
setInterval(() => { if (!busy && state?.job && !["succeeded", "failed", "rolled_back"].includes(state.job.state)) void run("status"); }, 2000);
