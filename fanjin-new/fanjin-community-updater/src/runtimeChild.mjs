// Parent disconnect stops the one child we own. Never signal an arbitrary PID.
import { spawn } from "node:child_process";
import path from "node:path";
const config = JSON.parse(process.env.FANJIN_MANAGED_RUNTIME);
const storage = Object.fromEntries(Object.entries(config.storage).filter(([key, value]) =>
  /^FANJIN_OBJECT_STORAGE_(PROVIDER|DRIVER|BUCKET|REGION|ENDPOINT|CDN_URL|ACCESS_KEY|SECRET_KEY|CORS_ORIGINS|URL_MODE|KEY_PREFIX|FORCE_PATH_STYLE|SIGNED_URL_TTL_SECONDS)$/.test(key) && typeof value === "string"));
const app = path.join(config.directory, "app");
const child = spawn(process.execPath, ["build-public/app.cjs"], {
  cwd: path.join(app, "fanjin-new/fanjin-api"), stdio: "inherit",
  env: {
    ...storage, PATH: process.env.PATH || "", NODE_ENV: "development",
    FANJIN_DISABLE_LOCAL_ENV: "1", FANJIN_DISABLE_LOCAL_KEYCHAIN_SECRETS: "1",
    FANJIN_PROCESS_ROLE: config.probe ? "api" : "all", FANJIN_READINESS_REQUIRE_WORKER: config.probe ? "0" : "1",
    FANJIN_DISABLE_RELAY_WORKER: config.probe ? "1" : "0",
    FANJIN_DATABASE_CLIENT: "sqlite", FANJIN_DATA_DIR: config.data,
    FANJIN_AUTO_MIGRATE: "1", FANJIN_ROOT_PASSWORD: config.rootPassword,
    FANJIN_BIND_HOST: "127.0.0.1", FANJIN_APP_PORT: String(config.port),
    FANJIN_WEB_DIR: path.join(app, "fanjin-new/fanjin-v4/dist"), FANJIN_DISABLE_BACKUP_SCHEDULER: "1",
    FANJIN_SHUTDOWN_TIMEOUT_MS: "60000", FANJIN_COMMUNITY_UPDATE_SECRET: config.token,
  },
});
const stop = () => child.kill("SIGTERM");
process.on("disconnect", stop);
process.on("message", message => { if (message?.type === "stop") stop(); });
process.on("SIGTERM", stop); process.on("SIGINT", stop);
child.on("error", () => process.exit(1));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
