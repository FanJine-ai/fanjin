import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import route from "@/routes/admin/releases/community-update";
import { classifyAdminOperation } from "@/middleware/adminOperationPolicy";

function app(role: string) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as any).auth = { user: { role } }; next(); });
  server.use("/community-update", route);
  return server;
}
afterEach(() => vi.unstubAllEnvs());
describe("local updater capability", () => {
  it("registers the real admin policy before routing, including root, audit and step-up", async () => {
    for (const method of ["GET", "POST"]) {
      await expect(classifyAdminOperation({ method, path: "/api/admin/releases/community-update" })).resolves.toMatchObject({
        hardGate: "platform_root", status: "ACTIVE", auditMode: "required",
        stepUpScope: method === "POST" ? "admin.deployment" : null,
        permissions: [method === "POST" ? "fjadmin:operations:releases:deploy" : "fjadmin:operations:releases:read"],
      });
    }
  });
  it("keeps ordinary administrators and unmanaged installations out", async () => {
    vi.stubEnv("FANJIN_COMMUNITY_UPDATE_SECRET", "");
    expect((await request(app("admin")).get("/community-update")).status).toBe(403);
    expect((await request(app("root")).get("/community-update")).body.data.managed).toBe(false);
    expect((await request(app("root")).post("/community-update").send({})).status).toBe(409);
  });
  it("issues only a short-lived install-specific capability without exposing the owner secret", async () => {
    const secret = "a".repeat(64);
    vi.stubEnv("FANJIN_COMMUNITY_UPDATE_SECRET", secret);
    const response = await request(app("root")).post("/community-update").send({});
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    const token = response.body.data.path.split("#token=")[1];
    const [payload, signature] = token.split(".");
    expect(signature).toBe(createHmac("sha256", secret).update(payload).digest("base64url"));
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(data.scope).toBe("local-update"); expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60000);
    expect(response.text).not.toContain(secret);
  });
});
