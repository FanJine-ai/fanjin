/** Adapters to the current account-owned asset library and verified multipart upload pipeline. */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Knex } from "knex";
import { db } from "@/utils/db";
import oss from "@/utils/oss";
import { assertAssetLibraryPermission, listAuthorizedAssetIds } from "@/lib/accountWorkspaceAssetLibrary";
import { managedFileVersion, updateFile } from "@/lib/assetFileManager";
import { PROJECT_ASSET_REF_TABLE } from "@/lib/migrations/accountWorkspaceAssetLibrary";
import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import { initReferenceMultipartUpload, getReferenceMultipartUploadStatus, createReferenceMultipartPartTarget, completeReferenceMultipartUpload, ReferenceMultipartUploadError } from "@/lib/referenceMultipartUpload";
import { openSecret, sealSecret } from "@/lib/secretEnvelope";
import { TOOL_UPLOAD_TABLE } from "@/lib/migrations/externalTools";
import { ToolError } from "./contracts";
import { toolPortraitStatus } from "./portraitStatus";
import { stableJson } from "./serialization";
import type { ToolIdentity } from "./creationService";
const purpose = "external-tool-upload/v1";
export const fileContext = (i: ToolIdentity) => ({ database: db, workspaceId: i.workspaceId, actorUserId: i.userId });
const fail = (code: string, message: string, status = 409): never => { throw new ToolError(code, message, status); };
const hash = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
export async function toolAsset(i: ToolIdentity, input: Record<string, any>) {
  await assertAssetLibraryPermission({ ...fileContext(i), assetId: input.assetId, permission: "view" });
  const query = db("o_assets as a").join("o_image as v", "v.assetsId", "a.id")
    .join(`${PROJECT_ASSET_REF_TABLE} as ref`, function () { this.on("ref.assetId", "a.id").andOn(db.raw("?? = 'image:' || CAST(?? AS TEXT)", ["ref.assetVersionId", "v.id"])); })
    .leftJoin(`${FILE_METADATA} as m`, "m.assetId", "a.id")
    .where({ "ref.workspaceId": i.workspaceId, "ref.projectId": input.projectId }).whereNull("ref.removedAt")
    .where({ "a.id": input.assetId, "a.deletionState": "active", "v.deletionState": "active" }).whereNull("m.trashedAt");
  if (input.assetVersionId) query.where("v.id", input.assetVersionId);
  const r = await query.select("a.id", "a.name", "a.type", "a.projectId", "a.startTime", "v.id as versionId", "v.type as mediaType", "v.storageKey", "v.filePath", "m.updatedAt", "m.revision").first();
  if (!r) fail("ASSET_NOT_FOUND", "素材不存在或不可用", 404);
  const key = String(r.storageKey || r.filePath || "").replace(/^\/+/, "");
  const stat = key ? await oss.getFileMetadata(key) : null;
  const [upload, media, portraitAdmission] = await Promise.all([
    db("o_reference_multipart_upload").where({ assetId: Number(r.id), assetVersionId: Number(r.versionId), status: "completed" }).select("actualSha256").first(),
    db("o_media_asset").where({ workspaceId: i.workspaceId, storageKey: key, deletionState: "active" }).select("metadata").first(),
    toolPortraitStatus({ database: db, workspaceId: i.workspaceId, projectId: input.projectId,
      assetVersionId: Number(r.versionId), actorUserId: i.userId }, r.mediaType),
  ]);
  let contentHash: string | null = upload?.actualSha256 || null;
  if (!contentHash && media?.metadata) { try { contentHash = JSON.parse(media.metadata).mediaProbe?.contentSha256 || JSON.parse(media.metadata).contentSha256 || null; } catch { /* legacy metadata */ } }
  return { assetId: Number(r.id), assetVersionId: Number(r.versionId), projectId: input.projectId, name: r.name, type: r.type,
    source: /\/assets\/references\//.test(key) ? "upload" : "generated", status: "active", storageKey: key || null,
    mimeType: stat?.mimeType || null, sizeBytes: stat?.sizeBytes || null, contentHash, portraitAdmission,
    updatedAt: Number(r.updatedAt || r.startTime || 1), revision: Number(r.revision || 1) };
}
async function authorization(i: ToolIdentity, input: Record<string, any>) {
  const r = await db(TOOL_UPLOAD_TABLE).where({ id: input.uploadId, projectId: input.projectId, workspaceId: i.workspaceId, userId: i.userId, keyId: i.keyId }).first();
  if (!r) fail("UPLOAD_NOT_FOUND", "上传会话不存在或无权访问", 404);
  return { sessionId: r.id, workspaceId: i.workspaceId, projectId: input.projectId, actorUserId: i.userId, resumeGrant: openSecret(r.resumeGrant, purpose) };
}
async function prepareToolUpload(i: ToolIdentity, input: Record<string, any>, transaction?: Knex.Transaction) {
  const database = transaction ?? db;
  try {
    const r = await initReferenceMultipartUpload({ workspaceId: i.workspaceId, actorUserId: i.userId, projectId: input.projectId,
      idempotencyKey: `tools:${i.keyId}:${input.idempotencyKey}`, fileName: input.assetName || input.fileName, mediaType: input.assetType, mimeType: input.mimeType, byteSize: input.sizeBytes, sha256: input.contentHash }, { database });
    // The multipart service rotates its grant when an interrupted prepare is resumed.
    // Keep the matching grant, otherwise the recovered upload cannot accept bytes.
    const resumeGrant = sealSecret(r.resumeGrant, purpose);
    await database(TOOL_UPLOAD_TABLE).insert({ id: r.sessionId, workspaceId: i.workspaceId, projectId: input.projectId, userId: i.userId, keyId: i.keyId, resumeGrant, createdAt: Date.now() })
      .onConflict("id").merge({ resumeGrant });
    return { uploadId: r.sessionId, uploadUrl: `/api/tools/v1/uploads/${r.sessionId}/content?projectId=${input.projectId}`, uploadMethod: "PUT", uploadHeaders: { "Content-Type": input.mimeType }, uploadMode: "proxy", expiresAt: r.expiresAt, maxBytes: r.byteSize };
  } catch (error) {
    if (error instanceof ReferenceMultipartUploadError) throw new ToolError(error.code, error.message, error.status);
    throw error;
  }
}

export const assetGateway = {
  async assetsList(i: ToolIdentity, input: Record<string, any>) {
    const scope = hash([i.workspaceId, i.keyId, i.userId, input.projectId, input.type]); let after: number | undefined;
    if (input.cursor) { try { const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); if (c.scope !== scope || !Number.isSafeInteger(c.after) || c.after <= 0) throw Error(); after = c.after; } catch { fail("INVALID_CURSOR", "无效素材游标", 400); } }
    const ids = await listAuthorizedAssetIds({ ...fileContext(i), view: "project_refs", projectId: input.projectId, permission: "view" });
    const query = db("o_assets as a").leftJoin(`${FILE_METADATA} as m`, "m.assetId", "a.id").whereIn("a.id", ids).where("a.deletionState", "active").whereNull("m.trashedAt");
    if (input.type) query.whereIn("a.type", input.type === "image" ? ["image", "role", "scene", "tool"] : input.type === "video" ? ["video", "clip"] : [input.type]);
    if (after) query.where("a.id", "<", after);
    const rows = await query.select("a.id").orderBy("a.id", "desc").limit(input.limit + 1), selected = rows.slice(0, input.limit);
    return { assets: await Promise.all(selected.map(r => toolAsset(i, { projectId: input.projectId, assetId: Number(r.id) }))), nextCursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ scope, after: Number(selected.at(-1)!.id) })).toString("base64url") : null };
  },
  assetGet: toolAsset,
  async rename(i: ToolIdentity, input: Record<string, any>, transaction: any) {
    const current = await toolAsset(i, input);
    if (current.updatedAt !== input.expectedUpdatedAt) fail("ASSET_REVISION_CONFLICT", "素材已变化，请重新读取");
    return updateFile({ ...fileContext(i), database: transaction }, { assetId: input.assetId, expectedRevision: current.revision, name: input.name });
  },
  prepareUpload: prepareToolUpload,
  recoverUploadPreparation: prepareToolUpload,
  async uploadStatus(i: ToolIdentity, input: Record<string, any>) {
    const r = await getReferenceMultipartUploadStatus(await authorization(i, input));
    return { uploadId: r.sessionId, status: r.status === "active" && r.uploadedByteSize === r.byteSize ? "uploaded" : r.status, sizeBytes: r.byteSize, expiresAt: r.expiresAt, assetId: r.asset?.assetId || null, assetVersionId: r.asset?.assetVersionId || null };
  },
  async completeUpload(i: ToolIdentity, input: Record<string, any>) {
    const r = await completeReferenceMultipartUpload(await authorization(i, input));
    if (!r.asset) fail("ASSET_NOT_STORED", "素材仍在校验中");
    return toolAsset(i, { projectId: input.projectId, ...r.asset });
  },
  async writeUpload(i: ToolIdentity, input: Record<string, any>, stream: Readable) {
    const auth = await authorization(i, input), status = await getReferenceMultipartUploadStatus(auth);
    if (status.status !== "active" || status.byteSize !== input.contentLength || status.mimeType !== input.contentType.split(";", 1)[0]) fail("UPLOAD_STATE_CONFLICT", "上传状态、大小或类型不符");
    let pending = Buffer.alloc(0), total = 0, part = 1;
    const checksum = createHash("sha256");
    const controller = new AbortController(), timer = setTimeout(() => { controller.abort(); stream.destroy(new Error("Upload timeout")); }, 15 * 60_000);
    async function put(bytes: Buffer) {
      const target = await createReferenceMultipartPartTarget({ ...auth, partNumber: part++ });
      if (target.byteSize !== bytes.length) fail("UPLOAD_SIZE_MISMATCH", "分片大小不符");
      const response = await fetch(target.url, { method: "PUT", body: new Uint8Array(bytes), headers: target.requiredHeaders, signal: controller.signal, redirect: "error" });
      if (!response.ok) fail("UPLOAD_STORAGE_UNAVAILABLE", "分片上传失败，可使用原上传会话重试", 502);
      await response.body?.cancel();
    }
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > status.byteSize) fail("UPLOAD_SIZE_MISMATCH", "文件超过声明大小");
        checksum.update(bytes); pending = Buffer.concat([pending, bytes]);
        while (pending.length >= status.partSize) { await put(pending.subarray(0, status.partSize)); pending = pending.subarray(status.partSize); }
      }
      if (pending.length) await put(pending);
      if (total !== status.byteSize || checksum.digest("hex") !== status.sha256) fail("UPLOAD_HASH_MISMATCH", "文件大小或 SHA-256 不符");
      return { uploadId: input.uploadId, status: "uploaded", sizeBytes: total };
    } finally { clearTimeout(timer); }
  },
  async download(i: ToolIdentity, input: Record<string, any>) {
    const a = await toolAsset(i, input);
    const file = await managedFileVersion(fileContext(i), input.assetId, a.assetVersionId);
    return oss.getFileStream(file.key);
  },
};
