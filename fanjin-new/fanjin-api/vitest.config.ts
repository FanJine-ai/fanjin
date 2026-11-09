import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./tests/setup/global.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    isolate: true,
    sequence: { hooks: "stack", setupFiles: "list" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
