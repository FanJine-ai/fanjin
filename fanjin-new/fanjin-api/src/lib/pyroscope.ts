// Pyroscope 性能剖析集成。
// 通过 FANJIN_PYROSCOPE_SERVER_ADDRESS 环境变量启用。
// 无 Pyroscope 依赖时静默跳过，不影响正常运行。
let enabled = false;

export function initPyroscope(): void {
  const serverAddress = process.env.FANJIN_PYROSCOPE_SERVER_ADDRESS;
  if (!serverAddress) return;

  try {
    // 动态加载，避免无 Pyroscope 环境下报错
    const Pyroscope = require("@pyroscope/nodejs");
    Pyroscope.init({
      serverAddress,
      appName: process.env.FANJIN_PYROSCOPE_APP_NAME || "fanjin-relay",
      tags: {
        env: process.env.NODE_ENV || "dev",
        role: process.env.FANJIN_PROCESS_ROLE || "all",
      },
    });
    Pyroscope.start();
    enabled = true;
    console.log("[pyroscope] 性能剖析已启动:", serverAddress);
  } catch (err: any) {
    console.warn("[pyroscope] 未启用（未安装 @pyroscope/nodejs 或配置错误）:", err?.message || err);
  }
}

export function isPyroscopeEnabled(): boolean {
  return enabled;
}
