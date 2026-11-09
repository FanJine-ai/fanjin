import { createBrowserUuid } from "../../lib/browserUuid";

export const EXTRACTION_BATCH_SCRIPT_LIMIT = 20;
export const EXTRACTION_BATCH_CHARACTER_LIMIT = 120_000;
export const EXTRACTION_BATCH_LIMIT = 200;
type Source = { id: number | string; content?: string; title?: string; name?: string };
export type ExtractionBatch = { scriptIds: number[]; characters: number; key: string; submitted: boolean; submittedAt?: number; proposalId?: string };
export type ExtractionBatchJob = {
  version: 1; projectId: number; batches: ExtractionBatch[]; mergeKey: string;
  phase: "running" | "paused" | "waiting" | "failed" | "ready";
  message: string; referenceId?: string; mergedProposalId?: string;
};
type BatchApi = (path: string, payload: Record<string, unknown>, key: string) => Promise<any>;
type BatchStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export function planScriptAssetBatches(sources: Source[]): Array<{ scriptIds: number[]; characters: number }> {
  const result: Array<{ scriptIds: number[]; characters: number }> = [];
  const seen = new Set<number>();
  for (const source of [...sources].sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = Number(source.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error("所选剧本包含无效或重复记录，请刷新列表");
    seen.add(id);
    const characters = String(source.content || "").length;
    if (characters > EXTRACTION_BATCH_CHARACTER_LIMIT) throw new Error(`“${source.title || source.name || `剧本 ${id}`}”单篇超过 12 万字，请先拆分这篇剧本`);
    let batch = result[result.length - 1];
    if (!batch || batch.scriptIds.length >= EXTRACTION_BATCH_SCRIPT_LIMIT || batch.characters + characters > EXTRACTION_BATCH_CHARACTER_LIMIT) {
      batch = { scriptIds: [], characters: 0 };
      result.push(batch);
    }
    batch.scriptIds.push(id);
    batch.characters += characters;
  }
  if (result.length > EXTRACTION_BATCH_LIMIT) throw new Error("本次任务超过 200 批，请按分集范围分别提取");
  return result;
}

/** Persists only IDs and request keys. Paid results stay in server-side durable
 * proposals. Leaving the page pauses dispatch; returning never auto-retries. */
export class ScriptAssetBatchController {
  job: ExtractionBatchJob | null = null;
  private active = true;
  private running = false;
  private pauseRequested = false;
  private revision = 0;
  constructor(private options: {
    projectId: number; storageKey: string; storage: BatchStorage; api: BatchApi;
    changed: (job: ExtractionBatchJob | null) => void; ready: (proposal: unknown) => void;
  }) {
    try {
      const parsed = JSON.parse(options.storage.getItem(options.storageKey) || "null");
      if (parsed?.version !== 1 || parsed.projectId !== options.projectId || typeof parsed.mergeKey !== "string"
        || !Array.isArray(parsed.batches) || !parsed.batches.length || parsed.batches.length > EXTRACTION_BATCH_LIMIT
        || parsed.batches.some((batch: ExtractionBatch) => !Array.isArray(batch.scriptIds) || !batch.scriptIds.length || batch.scriptIds.length > 20
          || batch.scriptIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || typeof batch.key !== "string" || !batch.key
          || typeof batch.submitted !== "boolean" || (batch.proposalId !== undefined && typeof batch.proposalId !== "string"))) return;
      this.job = { ...parsed, phase: parsed.phase === "ready" ? "ready" : "paused", message: "已恢复批处理进度；继续时会先核对已发出请求，不会重跑完成的批次" };
    } catch { /* Invalid local data never authorizes provider dispatch. */ }
  }
  private publish(job: ExtractionBatchJob) {
    this.options.storage.setItem(this.options.storageKey, JSON.stringify(job));
    this.job = job;
    if (this.active) this.options.changed({ ...job, batches: job.batches.map((batch) => ({ ...batch })) });
  }
  private setPhase(phase: ExtractionBatchJob["phase"], message: string, referenceId?: string) {
    if (this.job) this.publish({ ...this.job, phase, message, referenceId });
  }
  private rememberFailure(error: unknown) {
    const detail = error as { message?: string; details?: { referenceId?: string } };
    const message = detail?.message || "请求连接中断；继续时将先查询原请求，避免重复扣费";
    try { this.setPhase("failed", message, detail?.details?.referenceId); }
    catch {
      if (this.job && this.active) this.options.changed({ ...this.job, phase: "failed", message: "浏览器无法保存进度，已暂停后续批次。请恢复浏览器存储后重试" });
    }
  }
  async start(sources: Source[]) {
    if (this.job || this.running || !this.active) return;
    try {
      const plan = planScriptAssetBatches(sources);
      if (!plan.length) return;
      this.publish({ version: 1, projectId: this.options.projectId, mergeKey: `script-assets-merge:${createBrowserUuid()}`,
        batches: plan.map((batch) => ({ ...batch, key: `script-assets-batch:${createBrowserUuid()}`, submitted: false })),
        phase: "paused", message: "已规划批次" });
      await this.resume();
    } catch (error) { this.rememberFailure(error); throw error; }
  }
  pause() { this.pauseRequested = true; if (this.running) this.setPhase("running", "当前批次结束后暂停，后续批次不会继续发送"); }
  dispose() { this.active = false; this.pauseRequested = true; this.revision += 1; }
  clear() {
    if (this.running) return;
    this.revision += 1;
    this.options.storage.removeItem(this.options.storageKey);
    this.job = null;
    this.options.changed(null);
  }
  private proposalId(value: any): string {
    if (!value || typeof value.proposalId !== "string" || !value.proposalId || !Array.isArray(value.assets)) throw new Error("提取结果格式无效，请查询本批次处理状态");
    return value.proposalId;
  }
  private async observe(batch: ExtractionBatch) {
    return this.options.api("/script/extractAssets/status", { projectId: this.options.projectId }, batch.key);
  }
  async resume() {
    if (!this.job || this.running || !this.active) return;
    this.running = true;
    this.pauseRequested = false;
    const revision = this.revision;
    const current = () => this.active && revision === this.revision;
    try {
      this.setPhase("running", "正在继续批处理");
      for (let index = 0; index < this.job.batches.length; index += 1) {
        if (!current()) return;
        const batch = this.job.batches[index];
        if (batch.proposalId) continue;
        if (this.pauseRequested) { this.setPhase("paused", "已暂停；已完成批次的结果已保留"); return; }
        this.setPhase("running", `正在处理第 ${index + 1} / ${this.job.batches.length} 批`);
        if (batch.submitted) {
          let status;
          let definitelyNotReceived = false;
          try { status = await this.observe(batch); }
          catch (error) {
            // Persist-before-send may have been interrupted before the server
            // received anything. Only this exact 404 permits the same key.
            if ((error as { code?: string }).code !== "script_asset_extraction_attempt_not_found") throw error;
            // A missing old record may have been archived after its replay TTL.
            // Absence then cannot prove that the provider was never called.
            const elapsed = Date.now() - Number(batch.submittedAt || 0);
            if (!Number.isFinite(batch.submittedAt) || !batch.submittedAt || elapsed < 0 || elapsed > 60 * 60 * 1000) {
              this.setPhase("waiting", "未找到原批次的处理记录，请联系管理员核对后再提取，避免重复计费");
              return;
            }
            definitelyNotReceived = true;
          }
          if (!current()) return;
          if (!status && !definitelyNotReceived) throw new Error("批次状态响应无效，已暂停后续请求，请刷新处理状态");
          if (status?.state === "proposal_ready") {
            batch.proposalId = this.proposalId(status.proposal);
            this.publish(this.job);
            continue;
          }
          if (status && status.state !== "retry_allowed") {
            this.setPhase("waiting", status.message || "本批次仍在核对，请刷新处理状态", status.referenceId);
            return;
          }
          // resume() is an explicit user action. Background refresh only reads.
          if (status?.state === "retry_allowed" && (status.retryMode === "new_attempt" || status.canStartNewAttempt === true)) {
            batch.key = `script-assets-batch:${createBrowserUuid()}`;
          } else if (status?.state === "retry_allowed" && status.retryMode !== "same_attempt") {
            this.setPhase("waiting", "本批次尚未明确允许重试，请刷新处理状态", status.referenceId);
            return;
          }
        }
        if (this.pauseRequested) { this.setPhase("paused", "已暂停；已完成批次的结果已保留"); return; }
        batch.submitted = true;
        batch.submittedAt = Date.now();
        this.publish(this.job); // Must succeed before any paid POST.
        const result = await this.options.api("/script/extractAssets", { projectId: this.options.projectId, scriptIds: batch.scriptIds }, batch.key);
        if (!current()) return;
        batch.proposalId = this.proposalId(result);
        this.publish(this.job);
      }
      if (!current()) return;
      this.setPhase("running", "提取已完成，正在汇总重复资产");
      const proposal = await this.options.api("/script/extractAssets/merge", {
        projectId: this.options.projectId, proposalIds: this.job.batches.map((batch) => batch.proposalId),
      }, this.job.mergeKey);
      if (!current()) return;
      const mergedProposalId = this.proposalId(proposal);
      this.publish({ ...this.job, mergedProposalId, phase: "ready", message: "所有批次已完成，请统一审核资产后保存" });
      this.options.ready(proposal);
    } catch (error) { if (current()) this.rememberFailure(error); }
    finally { this.running = false; }
  }
  async refresh() {
    if (!this.job || this.running || !this.active) return;
    const batch = this.job.batches.find((item) => !item.proposalId);
    if (!batch || !batch.submitted) return;
    this.running = true;
    const revision = this.revision;
    try {
      const status = await this.observe(batch);
      if (!this.active || revision !== this.revision) return;
      if (status.state === "proposal_ready") {
        batch.proposalId = this.proposalId(status.proposal);
        this.setPhase("paused", "本批次结果已恢复；可继续剩余批次");
      } else {
        this.setPhase(status.state === "retry_allowed" ? "paused" : "waiting", status.message || "正在核对本批次处理状态", status.referenceId);
      }
    } catch (error) { if (this.active && revision === this.revision) this.rememberFailure(error); }
    finally { this.running = false; }
  }
}
