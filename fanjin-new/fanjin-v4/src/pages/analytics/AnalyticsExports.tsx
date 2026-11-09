import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button, Dialog } from "../../ui/console";
import { apiPost } from "../../api/http";
import { date, type Filters } from "./analytics";
type Job = { id: string; status: string; kind: string; format: string; rows: number; parts: number; createdAt: number; expiresAt: number; filename: string; errorCode?: string };
const statusLabel: Record<string, string> = { queued: "等待生成", running: "正在生成", succeeded: "可下载", cancelled: "已取消", expired: "已过期", failed: "生成失败" };
export function AnalyticsExports({ filters, kind, disabled }: { filters: Filters; kind: "usage" | "ledger"; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [jobs, setJobs] = useState<Job[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [downloadId, setDownloadId] = useState<string>(), [progress, setProgress] = useState(0);
  const alive = useRef(true), downloadAbort = useRef<AbortController | null>(null), requestKey = useRef<{ filters: string; id: string } | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; downloadAbort.current?.abort(); }; }, []);
  const scope = { scope: filters.scope, workspaceId: filters.workspaceId, kind };
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await apiPost<{ items: Job[] }>("/analytics/export-jobs", scope, undefined, { signal: controller.signal });
        if (!controller.signal.aborted) { setJobs(result.items); setError(""); if (result.items.some(job => ["queued", "running"].includes(job.status))) timer = setTimeout(load, 2000); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "任务读取失败"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [open, refresh, filters.scope, filters.workspaceId, kind]);
  async function create() {
    setBusy(true); setError("");
    const query = { ...filters, kind, format: "csv" }, fingerprint = JSON.stringify(query);
    // A lost response retries the same export; changed filters start a new one.
    if (requestKey.current?.filters !== fingerprint) requestKey.current = { filters: fingerprint, id: crypto.randomUUID() };
    const request = requestKey.current;
    try { await apiPost("/analytics/export-create", { ...query, idempotencyKey: request.id }); if (alive.current) { if (requestKey.current === request) requestKey.current = undefined; setOpen(true); setRefresh(v => v + 1); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "创建导出失败，请重试"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function download(job: Job) {
    const controller = new AbortController(); downloadAbort.current = controller;
    setDownloadId(job.id); setProgress(0); setError("");
    let writer: { write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | undefined;
    try {
      // Supported browsers stream to a user-selected file. Other browsers use
      // Blob parts; large files require a browser supporting streamed file writes.
      const picker = (window as any).showSaveFilePicker;
      if (picker) writer = await (await picker.call(window, { suggestedName: job.filename, types: [{ description: "CSV 表格", accept: { "text/csv": [".csv"] } }] })).createWritable();
      const chunks: string[] = []; let bytes = 0, part: number | null = 0;
      if (writer) await writer.write("\uFEFF"); else chunks.push("\uFEFF");
      while (part !== null && !controller.signal.aborted) {
        const result: { content: string; nextPart: number | null } = await apiPost("/analytics/export-part", { ...scope, id: job.id, part }, undefined, { signal: controller.signal });
        if (writer) await writer.write(result.content); else {
          bytes += new Blob([result.content]).size;
          if (bytes > 64 * 1024 * 1024) throw new Error("文件较大，请在 Chrome 或 Edge 中打开并下载；导出任务会保留，无需重新生成。");
          chunks.push(result.content);
        }
        if (result.nextPart !== null && result.nextPart <= part) throw new Error("下载分段未推进，请重试");
        setProgress(part + 1); part = result.nextPart;
      }
      if (controller.signal.aborted) throw new DOMException("取消下载", "AbortError");
      if (writer) await writer.close(); else {
        const url = URL.createObjectURL(new Blob(chunks, { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = job.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { await writer?.abort().catch(() => {}); if (alive.current && !controller.signal.aborted && (e as Error)?.name !== "AbortError") setError(e instanceof Error ? e.message : "下载失败，请重试"); }
    finally { if (alive.current) setDownloadId(undefined); }
  }
  return <><Button variant="secondary" icon={<Download size={15} />} disabled={disabled || busy} onClick={() => void create()}>{busy ? "创建导出…" : "导出"}</Button><Button variant="ghost" onClick={() => { setOpen(true); setRefresh(v => v + 1); }}>导出任务</Button>{error && !open && <span role="alert">{error}</span>}
    <Dialog open={open} onOpenChange={setOpen} title="导出任务" description="关闭页面后继续生成。结果保留 24 小时，下载时校验当前权限。" size="lg"><div className="analyticsDetailBody">
      {error && <p role="alert" className="analyticsError">{error}</p>}<Button variant="secondary" onClick={() => setRefresh(v => v + 1)}>刷新任务</Button>
      {loading && !jobs.length && <p role="status">正在读取导出任务…</p>}{!loading && !jobs.length && !error && <p>暂无导出任务。点击“导出”按当前筛选创建。</p>}
      {jobs.map(job => <article className="analyticsExportJob" key={job.id}><div><strong>{job.kind === "ledger" ? "资金流水" : "调用明细"} · {statusLabel[job.status] || job.status}</strong><small>{date(job.createdAt)} · 已生成 {job.rows.toLocaleString("zh-CN")} 行</small><small>到期时间 {date(job.expiresAt)}</small>{job.status === "failed" && <small>生成未完成，请按当前筛选重新导出。</small>}</div><div className="analyticsActions">{job.status === "succeeded" && <Button variant="secondary" disabled={Boolean(downloadId)} onClick={() => void download(job)}>{downloadId === job.id ? `下载 ${progress}/${job.parts}` : "下载"}</Button>}{["queued", "running"].includes(job.status) && <Button variant="ghost" onClick={async () => { try { await apiPost("/analytics/export-cancel", { ...scope, id: job.id }); setRefresh(v => v + 1); } catch (e) { setError(e instanceof Error ? e.message : "取消失败"); } }}>取消生成</Button>}</div></article>)}
      {downloadId && <Button variant="ghost" onClick={() => downloadAbort.current?.abort()}>取消下载</Button>}
    </div></Dialog></>;
}
