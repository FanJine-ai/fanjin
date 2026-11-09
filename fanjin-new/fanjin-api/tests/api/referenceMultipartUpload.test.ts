import { upReferenceDocumentUpload } from "@/lib/migrations/referenceDocumentUpload";
import { createHash } from "node:crypto";
import knex, { type Knex } from "knex";
import { afterEach, describe, expect, it } from "vitest";

import {
  completeReferenceMultipartUpload,
  referenceMagicMatchesMime,
  createReferenceMultipartPartTarget,
  getReferenceMultipartUploadStatus,
  initReferenceMultipartUpload,
  REFERENCE_MULTIPART_PART_SIZE,
  ReferenceMultipartUploadError,
  type ReferenceMultipartStorage,
  type ReferenceMultipartUploadDependencies,
} from "@/lib/referenceMultipartUpload";
import {
  REFERENCE_MULTIPART_UPLOAD_TABLE,
  upReferenceMultipartUpload,
} from "@/lib/migrations/referenceMultipartUpload";
import {
  ASSET_OWNERSHIP_TABLE,
  PROJECT_ASSET_REF_TABLE,
  upAccountWorkspaceAssetLibrary,
} from "@/lib/migrations/accountWorkspaceAssetLibrary";
import {
  PORTRAIT_ADMISSION_TABLE,
  upPortraitAssetAdmission,
} from "@/lib/migrations/portraitAssetAdmission";
import { isReferenceAssetDeliveryPath } from "@/lib/referenceAssetDeliveryPath";
import type {
  ObjectStorageGenerationSnapshot,
  ObjectStorageMultipartPart,
} from "@/lib/objectStorage";

const clients: Knex[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

class FakeMultipartStorage implements ReferenceMultipartStorage {
  parts: ObjectStorageMultipartPart[] = [];
  completed = false;
  deleted = false;
  completionCalls = 0;
  getUrlCalls = 0;
  body = PNG;
  mimeType = "image/png";

  async initiateMultipartUpload() {
    return { uploadId: "upload-id-12345678", requestId: "init-request" };
  }

  async createMultipartPartUploadUrl(
    _key: string,
    options: { uploadId: string; partNumber: number; contentLength: number },
  ) {
    return {
      url: `https://storage.example.com/upload?part=${options.partNumber}`,
      method: "PUT" as const,
      expiresAt: 1_700_000_600_000,
      requiredHeaders: {},
    };
  }

  async listMultipartParts() {
    return { parts: this.parts, requestId: "list-request" };
  }

  async completeMultipartUpload(
    _key: string,
    _options: { uploadId: string; parts: ObjectStorageMultipartPart[] },
  ) {
    this.completionCalls += 1;
    this.completed = true;
    return {
      etag: "completed-etag",
      versionId: "version-1",
      requestId: "complete-request",
    };
  }

  async abortMultipartUpload() {
    return { requestId: "abort-request" };
  }

  async inspectGeneration(key: string): Promise<ObjectStorageGenerationSnapshot> {
    return {
      provider: "tos",
      bucket: "reference-test",
      key,
      exists: this.completed && !this.deleted,
      deleteMarker: false,
      etag: this.completed && !this.deleted ? "completed-etag" : null,
      versionId: this.completed && !this.deleted ? "version-1" : null,
      size: this.completed && !this.deleted ? this.body.length : null,
      contentType: this.completed && !this.deleted ? this.mimeType : null,
      lastModified: this.completed && !this.deleted
        ? "2026-08-05T00:00:00.000Z"
        : null,
      requestId: "head-request",
    };
  }

  async get() {
    return this.body;
  }

  async getUrl() {
    this.getUrlCalls += 1;
    return "https://storage.example.com/reference.png";
  }

  async deleteGenerationIfMatch() {
    this.deleted = true;
    return { outcome: "deleted" as const, requestId: "delete-request" };
  }
}

async function database(): Promise<Knex> {
  const client = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
  clients.push(client);
  await client.raw("PRAGMA foreign_keys = ON");
  await client.schema.createTable("o_workspace", (table) => table.text("id").primary());
  await client.schema.createTable("o_user", (table) => table.increments("id").primary());
  await client.schema.createTable("o_project", (table) => {
    table.increments("id").primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("userId");
    table.bigInteger("createTime");
    table.text("deletionState").notNullable().defaultTo("active");
  });
  await client.schema.createTable("o_workspace_member", (table) => {
    table.text("id").primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("userId").notNullable();
    table.text("role").notNullable();
    table.text("status").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
  await client.schema.createTable("o_assets", (table) => {
    table.increments("id").primary();
    table.text("type").notNullable();
    table.bigInteger("projectId").notNullable();
    table.text("name").notNullable();
    table.bigInteger("startTime").notNullable();
    table.bigInteger("imageId");
    table.text("deletionState").notNullable().defaultTo("active");
  });
  await client.schema.createTable("o_image", (table) => {
    table.increments("id").primary();
    table.text("filePath").notNullable();
    table.text("storageKey").notNullable();
    table.text("type").notNullable();
    table.bigInteger("assetsId").notNullable();
    table.text("state").notNullable();
  });
  await client.schema.createTable("o_provider_channel", (table) => {
    table.text("id").primary();
  });
  await client.schema.createTable("o_workflow_graph", (table) => {
    table.increments("id").primary();
    table.bigInteger("projectId").notNullable();
  });
  await client("o_workspace").insert({ id: "workspace-1" });
  await client("o_workspace").insert({ id: "workspace-2" });
  await client("o_user").insert({ id: 1 });
  await client("o_project").insert({
    id: 11,
    workspaceId: "workspace-1",
    userId: 1,
    createTime: 1,
    deletionState: "active",
  });
  await client("o_workspace_member").insert({
    id: "member-1",
    workspaceId: "workspace-1",
    userId: 1,
    role: "owner",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  await client.transaction(upAccountWorkspaceAssetLibrary);
  await client.transaction(upReferenceMultipartUpload);
  await client.transaction(upReferenceDocumentUpload);
  await client.transaction(upPortraitAssetAdmission);
  return client;
}

function dependencies(
  client: Knex,
  storage: FakeMultipartStorage,
  clock: { now: number },
): ReferenceMultipartUploadDependencies {
  let grant = 0;
  return {
    database: client,
    now: () => clock.now,
    createId: () => "00000000-0000-4000-8000-000000000001",
    randomGrant: () => `resume-grant-${String(++grant).padStart(32, "0")}`,
    resolveConfiguration: () => ({
      provider: "tos",
      bucket: "reference-test",
      region: "cn-test",
      endpoint: "https://tos.example.com",
      accessKey: "test-access-key",
      secretKey: "test-secret-key",
      keyPrefix: "",
      urlMode: "signed",
      signedUrlTtlSeconds: 900,
      forcePathStyle: false,
      corsOrigins: ["https://app.example.com"],
    }),
    createStorage: () => storage,
    probeMedia: async () => ({ kind: "image", width: 1, height: 1 }),
  };
}

const initInput = {
  workspaceId: "workspace-1",
  projectId: 11,
  actorUserId: 1,
  idempotencyKey: "reference-upload-request-1",
  fileName: "reference.png",
  mediaType: "image" as const,
  mimeType: "image/png",
  byteSize: PNG.length,
  sha256: digest(PNG),
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.destroy()));
});

describe("project reference multipart API service", () => {
  it("resumes from provider ListParts and atomically creates Asset/Version only after verification", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload(initInput, deps);
    expect(initialized).toMatchObject({
      protocolVersion: "reference-multipart-upload/v1",
      partCount: 1,
      status: "active",
      uploadedParts: [],
      idempotent: false,
    });
    const auth = {
      sessionId: initialized.sessionId,
      resumeGrant: initialized.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    };
    const target = await createReferenceMultipartPartTarget({
      ...auth,
      partNumber: 1,
    }, deps);
    expect(target).toMatchObject({
      partNumber: 1,
      byteOffset: 0,
      byteSize: PNG.length,
      method: "PUT",
    });
    storage.parts = [{
      partNumber: 1,
      etag: "part-etag-1",
      size: PNG.length,
      lastModified: "2026-08-05T00:00:00.000Z",
    }];
    const resumed = await getReferenceMultipartUploadStatus(auth, deps);
    expect(resumed).toMatchObject({
      uploadedByteSize: PNG.length,
      uploadedParts: [{ partNumber: 1, byteSize: PNG.length }],
    });
    expect(await client(PORTRAIT_ADMISSION_TABLE).count({ count: "*" }).first())
      .toMatchObject({ count: 0 });
    const completed = await completeReferenceMultipartUpload(auth, deps);
    expect(completed).toMatchObject({
      status: "completed",
      idempotent: false,
      asset: {
        assetId: expect.any(Number),
        assetVersionId: expect.any(Number),
        previewUrl: `/api/assets/getReferenceFile?id=${completed.asset?.assetId}&disposition=inline`,
        type: "image",
        mimeType: "image/png",
      },
    });
    expect(storage.getUrlCalls).toBe(0);
    expect(await client("o_assets").count({ count: "*" }).first()).toMatchObject({ count: 1 });
    expect(await client("o_image").count({ count: "*" }).first()).toMatchObject({ count: 1 });
    const persistedImage = await client("o_image")
      .where({ id: completed.asset?.assetVersionId })
      .first();
    expect(isReferenceAssetDeliveryPath({
      filePath: persistedImage?.filePath,
      projectId: 11,
      workspaceId: "workspace-1",
    })).toBe(true);
    expect(isReferenceAssetDeliveryPath({
      filePath: persistedImage?.filePath,
      projectId: 11,
      workspaceId: "workspace-2",
    })).toBe(false);
    expect(isReferenceAssetDeliveryPath({
      filePath: "/workspaces/workspace-1/projects/11/references/not-a-session/source.png",
      projectId: 11,
      workspaceId: "workspace-1",
    })).toBe(false);
    expect(await client(ASSET_OWNERSHIP_TABLE)
      .where({ assetId: completed.asset?.assetId })
      .first()).toMatchObject({
      ownerType: "user",
      ownerUserId: 1,
      sourceWorkspaceId: "workspace-1",
    });
    expect(await client(PROJECT_ASSET_REF_TABLE)
      .where({ assetId: completed.asset?.assetId })
      .first()).toMatchObject({
      workspaceId: "workspace-1",
      projectId: 11,
      assetVersionId: `image:${completed.asset?.assetVersionId}`,
      removedAt: null,
    });
    expect(await client(REFERENCE_MULTIPART_UPLOAD_TABLE).first()).toMatchObject({
      status: "completed",
      actualSha256: digest(PNG),
      assetId: completed.asset?.assetId,
      assetVersionId: completed.asset?.assetVersionId,
    });
    expect(await client(PORTRAIT_ADMISSION_TABLE).first()).toMatchObject({
      workspaceId: "workspace-1",
      projectId: 11,
      assetId: completed.asset?.assetId,
      assetVersionId: completed.asset?.assetVersionId,
      mediaType: "image",
      sourceSha256: digest(PNG),
      faceScanState: "queued",
      faceScanCoverage: "none",
      subjectKind: "pending",
      moderationState: "pending",
      complianceState: "pending",
      providerSyncState: "not_needed",
    });
  });

  it("rotates the narrow resume grant and rejects idempotency replay conflicts", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const first = await initReferenceMultipartUpload(initInput, deps);
    const second = await initReferenceMultipartUpload(initInput, deps);
    expect(second).toMatchObject({ sessionId: first.sessionId, idempotent: true });
    expect(second.resumeGrant).not.toBe(first.resumeGrant);
    await expect(getReferenceMultipartUploadStatus({
      sessionId: first.sessionId,
      resumeGrant: first.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    }, deps)).rejects.toMatchObject({ status: 403 });
    await expect(initReferenceMultipartUpload({
      ...initInput,
      fileName: "different.png",
    }, deps)).rejects.toMatchObject({
      status: 409,
      code: "REFERENCE_UPLOAD_REPLAY_CONFLICT",
    });
  });

  it("recovers a persisted verifying session after restart without re-uploading parts", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload(initInput, deps);
    storage.completed = true;
    await client(REFERENCE_MULTIPART_UPLOAD_TABLE)
      .where({ id: initialized.sessionId })
      .update({
        status: "verifying",
        completionEtag: "completed-etag",
        completionVersionId: "version-1",
        completionRequestId: "complete-before-restart",
        revision: 2,
      });

    const restarted = await initReferenceMultipartUpload(initInput, deps);
    expect(restarted).toMatchObject({
      sessionId: initialized.sessionId,
      status: "verifying",
      idempotent: true,
    });
    expect(restarted.resumeGrant).not.toBe(initialized.resumeGrant);
    const completed = await completeReferenceMultipartUpload({
      sessionId: restarted.sessionId,
      resumeGrant: restarted.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    }, deps);
    expect(completed).toMatchObject({ status: "completed", idempotent: true });
    expect(storage.completionCalls).toBe(0);
    expect(await client("o_assets").count({ count: "*" }).first())
      .toMatchObject({ count: 1 });
  });

  it("recovers a completing claim made before the provider completion call", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload(initInput, deps);
    storage.parts = [{
      partNumber: 1,
      etag: "part-etag-1",
      size: PNG.length,
      lastModified: "2026-08-05T00:00:00.000Z",
    }];
    await client(REFERENCE_MULTIPART_UPLOAD_TABLE)
      .where({ id: initialized.sessionId })
      .update({ status: "completing", revision: 2 });

    const restarted = await initReferenceMultipartUpload(initInput, deps);
    expect(restarted).toMatchObject({ status: "completing", idempotent: true });
    const completed = await completeReferenceMultipartUpload({
      sessionId: restarted.sessionId,
      resumeGrant: restarted.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    }, deps);
    expect(completed).toMatchObject({ status: "completed", idempotent: true });
    expect(storage.completionCalls).toBe(1);
  });

  it("hides foreign workspace sessions and rejects expired leases", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload(initInput, deps);
    await expect(getReferenceMultipartUploadStatus({
      sessionId: initialized.sessionId,
      resumeGrant: initialized.resumeGrant,
      workspaceId: "workspace-2",
      projectId: 11,
      actorUserId: 1,
    }, deps)).rejects.toMatchObject({ status: 404 });
    clock.now = initialized.expiresAt;
    await expect(getReferenceMultipartUploadStatus({
      sessionId: initialized.sessionId,
      resumeGrant: initialized.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    }, deps)).rejects.toMatchObject({
      status: 410,
      code: "REFERENCE_UPLOAD_SESSION_EXPIRED",
    });
  });

  it("rejects part gaps and malformed provider ETags before completion", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    storage.body = Buffer.alloc(REFERENCE_MULTIPART_PART_SIZE + 1, 1);
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload({
      ...initInput,
      byteSize: storage.body.length,
      sha256: digest(storage.body),
    }, deps);
    const auth = {
      sessionId: initialized.sessionId,
      resumeGrant: initialized.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    };
    storage.parts = [{
      partNumber: 2,
      etag: "part-etag-2",
      size: 1,
      lastModified: "2026-08-05T00:00:00.000Z",
    }];
    await expect(completeReferenceMultipartUpload(auth, deps)).rejects.toMatchObject({
      status: 409,
      code: "REFERENCE_UPLOAD_PARTS_INCOMPLETE",
    });
    storage.parts[0].etag = "";
    await expect(getReferenceMultipartUploadStatus(auth, deps)).rejects.toMatchObject({
      status: 502,
      code: "REFERENCE_UPLOAD_PROVIDER_PARTS_INVALID",
    });
  });

  it("compensates the completed object and leaves no Asset on digest mismatch", async () => {
    const client = await database();
    const storage = new FakeMultipartStorage();
    const clock = { now: 1_700_000_000_000 };
    const deps = dependencies(client, storage, clock);
    const initialized = await initReferenceMultipartUpload({
      ...initInput,
      sha256: "f".repeat(64),
    }, deps);
    storage.parts = [{
      partNumber: 1,
      etag: "part-etag-1",
      size: PNG.length,
      lastModified: "2026-08-05T00:00:00.000Z",
    }];
    await expect(completeReferenceMultipartUpload({
      sessionId: initialized.sessionId,
      resumeGrant: initialized.resumeGrant,
      workspaceId: "workspace-1",
      projectId: 11,
      actorUserId: 1,
    }, deps)).rejects.toBeInstanceOf(ReferenceMultipartUploadError);
    expect(storage.deleted).toBe(true);
    expect(await client("o_assets").count({ count: "*" }).first()).toMatchObject({ count: 0 });
    expect(await client(REFERENCE_MULTIPART_UPLOAD_TABLE).first()).toMatchObject({
      status: "failed",
      errorCode: "REFERENCE_UPLOAD_DIGEST_MISMATCH",
    });
  });
});


describe("MCP document upload admission", () => {
  it.each([["text/plain", "txt", "素材计划"], ["text/markdown", "md", "# 分镜\n内容"], ["application/pdf", "pdf", "%PDF-1.4\nsynthetic"]])("saves %s as a reusable document without portrait registration", async (mime, ext, content) => {
    const client = await database(), storage = new FakeMultipartStorage();
    storage.body = Buffer.from(content); storage.mimeType = mime;
    const deps = { ...dependencies(client, storage, { now: 1_700_000_000_000 }), probeMedia: undefined };
    const input = { ...initInput, mediaType: "document" as const, fileName: `script.${ext}`, mimeType: mime, byteSize: storage.body.length, sha256: digest(storage.body) };
    const upload = await initReferenceMultipartUpload(input, deps);
    const auth = { sessionId: upload.sessionId, resumeGrant: upload.resumeGrant, workspaceId: input.workspaceId, projectId: input.projectId, actorUserId: input.actorUserId };
    await createReferenceMultipartPartTarget({ ...auth, partNumber: 1 }, deps);
    storage.parts = [{ partNumber: 1, etag: "fixture-part", size: storage.body.length, lastModified: "2026-11-01T00:00:00Z" }];
    const result = await completeReferenceMultipartUpload(auth, deps);
    expect(result).toMatchObject({ status: "completed", asset: { type: "document", mimeType: mime } });
    expect((await completeReferenceMultipartUpload(auth, deps)).asset?.assetVersionId).toBe(result.asset?.assetVersionId);
    expect(await client(PORTRAIT_ADMISSION_TABLE).count({ count: "*" }).first()).toMatchObject({ count: 0 });
  });
  it("rejects binary text, invalid UTF-8, fake PDF and oversized documents", async () => {
    expect(referenceMagicMatchesMime("text/plain", Buffer.from([0xff, 0xfe]))).toBe(false);
    expect(referenceMagicMatchesMime("text/markdown", Buffer.from("abc\0xyz"))).toBe(false);
    expect(referenceMagicMatchesMime("application/pdf", PNG)).toBe(false);
    const client = await database(), storage = new FakeMultipartStorage();
    await expect(initReferenceMultipartUpload({ ...initInput, mediaType: "document", mimeType: "text/plain", fileName: "x.txt", byteSize: 20 * 1024 * 1024 + 1 }, dependencies(client, storage, { now: 1 }))).rejects.toMatchObject({ status: 413 });
    expect(await client(REFERENCE_MULTIPART_UPLOAD_TABLE).count({ count: "*" }).first()).toMatchObject({ count: 0 });
  });
});
