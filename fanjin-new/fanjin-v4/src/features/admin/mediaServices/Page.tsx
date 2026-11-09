import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCcw, Save } from "lucide-react";
import { Alert, Badge, Button, ConsolePage, DataTable, Drawer, FieldGroup, FilterBar, FormField, Input, Select, Switch, type DataTableColumn } from "../../../ui/console";
import { checkMediaService, listMediaServices, saveMediaService, type MediaService, type MediaServiceInput, type MediaServiceKind, type MediaServiceCheck } from "./api";
import "../providers/providers.css";

type Form = MediaServiceInput & { apiKey: string; serviceId: string; accessKeyId: string; secretAccessKey: string; sessionToken: string };
export function emptyMediaServiceForm(kind: MediaServiceKind = "mediakit"): Form {
  return { kind, name: "", enabled: false, acceptNewJobs: false, apiKey: "", serviceId: "", accessKeyId: "", secretAccessKey: "", sessionToken: "" };
}
export function mediaServicePayload(form: Form, existing?: MediaService): MediaServiceInput {
  if (!form.name.trim()) throw new Error("请填写服务名称");
  const common = { kind: form.kind, name: form.name.trim(), enabled: form.enabled,
    ...(existing ? { id: existing.id, expectedUpdateTime: existing.updateTime } : {}) };
  if (form.kind === "mediakit") {
    if (form.enabled && !form.apiKey.trim() && !existing?.configured) throw new Error("启用前请填写 MediaKit API Key");
    return { ...common, ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) };
  }
  const changed = Boolean(form.accessKeyId.trim() || form.secretAccessKey || form.sessionToken || form.serviceId.trim() !== (existing?.serviceId || ""));
  if (changed && (!form.serviceId.trim() || !form.accessKeyId.trim() || !form.secretAccessKey)) throw new Error("轮换时请完整填写 Service ID、Access Key ID 和 Secret Access Key");
  if (form.enabled && !changed && !existing?.configured) throw new Error("启用前请填写 ImageX Service ID 与 AK/SK");
  return { ...common, acceptNewJobs: form.enabled, ...(changed ? { serviceId: form.serviceId.trim(), accessKeyId: form.accessKeyId.trim(), secretAccessKey: form.secretAccessKey, sessionToken: form.sessionToken } : {}) };
}
const labels = { mediakit: "MediaKit 大模型版超分", imagex: "ImageX 人脸检测与安全审核" };

export default function MediaServicesPage() {
  const [services, setServices] = useState<MediaService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [existing, setExisting] = useState<MediaService>();
  const [form, setForm] = useState<Form>(emptyMediaServiceForm());
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState("");
  const [checkResult, setCheckResult] = useState<(MediaServiceCheck & { serviceName: string })>();
  const [formError, setFormError] = useState("");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const reload = useCallback(async () => {
    setLoading(true); setError("");
    try { setServices(await listMediaServices()); }
    catch (e) { setError(e instanceof Error ? e.message : "读取媒体服务失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  function edit(service?: MediaService) {
    setExisting(service);
    setForm({ ...emptyMediaServiceForm(service?.kind), ...(service ? {
      id: service.id, name: service.name, enabled: service.enabled, serviceId: service.serviceId,
      expectedUpdateTime: service.updateTime,
      acceptNewJobs: service.acceptNewJobs ?? (service.kind === "imagex" && service.enabled),
    } : {}) });
    setFormError(""); setOpen(true);
  }
  function close() { if (saving) return; setOpen(false); setForm(emptyMediaServiceForm()); setExisting(undefined); setFormError(""); }
  async function save() {
    setSaving(true); setFormError("");
    try {
      await saveMediaService(mediaServicePayload(form, existing));
      setCheckResult(undefined);
      setOpen(false); setForm(emptyMediaServiceForm()); setExisting(undefined);
      setNotice("媒体服务已保存。凭据状态不代表付费处理或审核已经验收通过。");
      await reload();
    } catch (e) { setFormError(e instanceof Error ? e.message : "保存失败"); }
    finally { setSaving(false); }
  }
  async function check(service: MediaService) {
    setChecking(service.id); setError(""); setNotice(""); setCheckResult(undefined);
    try { const result = await checkMediaService(service.id); setCheckResult({ ...result, serviceName: service.name }); await reload(); }
    catch (e) { setCheckResult({ ok: false, serviceName: service.name, message: e instanceof Error ? e.message : "连接检查失败" }); }
    finally { setChecking(""); }
  }
  const rows = services.filter(service => (!kindFilter || service.kind === kindFilter) && `${service.name} ${labels[service.kind]} ${service.serviceId}`.toLowerCase().includes(query.trim().toLowerCase()));
  const columns: DataTableColumn<MediaService>[] = [
    { id: "name", header: "服务名称", priority: "primary", sortable: true, sortValue: row => row.name, minWidth: "200px", cell: row => <div className="providerChannelCell"><strong>{row.name}</strong><span>{row.kind === "imagex" ? `Service ID：${row.serviceId || "未配置"}` : "画质增强（大模型版）"}</span></div> },
    { id: "kind", header: "服务类型", priority: "secondary", cell: row => row.kind === "mediakit" ? "MediaKit" : "ImageX" },
    { id: "credential", header: "凭据", priority: "secondary", cell: row => <Badge tone={row.configured ? "success" : "warning"}>{row.configured ? "已配置" : "未配置"}</Badge> },
    { id: "status", header: "状态", priority: "primary", minWidth: "100px", cell: row => <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "启用" : "停用"}</Badge> },
    { id: "connection", header: "连接检查", priority: "detail", cell: row => <Badge tone={row.requiresConfiguration ? "warning" : row.healthStatus === "ok" ? "success" : row.healthStatus === "failed" ? "danger" : "neutral"}>{row.requiresConfiguration ? "待确认升级" : row.healthStatus === "limited" ? "基础检查通过" : row.healthStatus === "ok" ? "已通过" : row.healthStatus === "failed" ? "失败" : "未检查"}</Badge> },
    { id: "actions", header: "操作", priority: "primary", hideable: false, minWidth: "185px", cell: row => <div className="adminFeatureRowActions"><Button variant="secondary" size="compact" onClick={() => edit(row)}>编辑配置</Button><Button variant="secondary" size="compact" disabled={!row.configured || Boolean(checking)} loading={checking === row.id} onClick={() => void check(row)}>{row.kind === "imagex" ? "检查配置" : "检查连接"}</Button></div> },
  ];
  return <ConsolePage breadcrumbs={[{ label: "模型管理" }, { label: "媒体服务" }]} title="媒体服务" description="配置 MediaKit 超分和 ImageX 服务凭据。" layoutWidth="dashboard"
    primaryAction={<Button icon={<Plus size={18} />} onClick={() => edit()}>新增配置</Button>}>
    {notice ? <Alert tone="info" title="操作结果"><p>{notice}</p></Alert> : null}
    {checkResult ? <Alert tone={checkResult.ok ? "info" : "danger"} title={`${checkResult.serviceName} · 配置检查结果`}><p>{checkResult.message}</p>{checkResult.checks?.map(item => <p key={item.name}>{item.name}：{item.message}{item.code ? `（${item.code}）` : ""}{item.requestId ? ` 请求号：${item.requestId}` : ""}</p>)}</Alert> : null}
    <FilterBar actions={<Button variant="secondary" icon={<RefreshCcw size={17} />} loading={loading} onClick={() => void reload()}>刷新</Button>}>
      <Input aria-label="搜索媒体服务" placeholder="搜索服务名称、类型、Service ID" value={query} onChange={event => setQuery(event.currentTarget.value)} />
      <Select aria-label="按服务类型筛选" value={kindFilter} onChange={event => setKindFilter(event.currentTarget.value)}><option value="">全部服务类型</option><option value="mediakit">MediaKit</option><option value="imagex">ImageX</option></Select>
    </FilterBar>
    <DataTable rows={rows} columns={columns} getRowId={row => row.id} ariaLabel="媒体服务配置列表" loading={loading} error={error || undefined} onRetry={() => void reload()} emptyState={query || kindFilter ? "没有匹配的媒体服务配置" : "暂无配置，请先新增 MediaKit 或 ImageX 配置"} />
    <Drawer open={open} title={existing ? "编辑媒体服务" : "新增媒体服务"} description="密钥在服务端加密保存，保存后不回显；留空保留原凭据。" size="min(720px, 100vw)" initialFocusRef={nameRef} loading={saving} onOpenChange={value => { if (!value) close(); }}
      footer={<div className="providerDrawerActions"><Button type="button" variant="secondary" disabled={saving} onClick={close}>取消</Button><Button type="submit" form="media-service-form" icon={<Save size={17} />} loading={saving}>保存配置</Button></div>}>
      <form id="media-service-form" className="providerForm" onSubmit={event => { event.preventDefault(); void save(); }}>
        {formError ? <Alert tone="danger" title="配置未保存"><p>{formError}</p></Alert> : null}
        {existing?.requiresConfiguration ? <Alert tone="warning" title="待确认升级"><p>保存后使用大模型版超分。启用视频路由前需重新验证成本与链路。</p></Alert> : null}
        <FieldGroup variant="section" className="providerFormSection" legend="基本信息">
        <FormField label="服务类型" required><Select disabled={Boolean(existing) || saving} value={form.kind} onChange={event => setForm({ ...emptyMediaServiceForm(event.currentTarget.value as MediaServiceKind), name: form.name })}><option value="mediakit">MediaKit</option><option value="imagex">ImageX</option></Select></FormField>
        <FormField label="服务名称" required><Input ref={nameRef} value={form.name} maxLength={120} disabled={saving} onChange={event => setForm({ ...form, name: event.currentTarget.value })} /></FormField>
        </FieldGroup>
        <FieldGroup variant="section" className="providerFormSection" legend="连接与凭据" description={form.kind === "mediakit" ? "使用 AI MediaKit API Key；固定调用画质增强（大模型版）。连接检查不会创建付费任务。" : "使用独立 Service ID 与 AK/SK。保存配置不代表审核通过。"}>
        {form.kind === "mediakit" ? <FormField label="MediaKit API Key" help={existing?.configured ? "已加密保存；留空保持不变。" : "使用 AI MediaKit API Key，不是云账号 AK/SK。"}>
          <Input type="password" autoComplete="new-password" spellCheck={false} value={form.apiKey} disabled={saving} onChange={event => setForm({ ...form, apiKey: event.currentTarget.value })} />
        </FormField> : <>
          <FormField label="ImageX Service ID" help="轮换凭据时需同时填写完整 AK/SK。"><Input value={form.serviceId} disabled={saving} autoComplete="off" onChange={event => setForm({ ...form, serviceId: event.currentTarget.value })} /></FormField>
          {(["accessKeyId", "secretAccessKey", "sessionToken"] as const).map(key => <FormField key={key} label={{ accessKeyId: "Access Key ID", secretAccessKey: "Secret Access Key", sessionToken: "Session Token（可选）" }[key]} help={existing?.configured ? "不回显，留空保持原凭据；轮换时整体更新。" : undefined}>
            <Input type="password" autoComplete="new-password" spellCheck={false} value={form[key]} disabled={saving} onChange={event => setForm({ ...form, [key]: event.currentTarget.value })} />
          </FormField>)}
        </>}
        </FieldGroup>
        <Switch label="启用服务" description={form.kind === "imagex" ? "启用后使用当前服务；更换凭据会关闭旧审核任务，需要重新检查旧素材。" : "未完成的超分任务仍会保护当前凭据。"} checked={form.enabled} disabled={saving} onCheckedChange={enabled => setForm({ ...form, enabled, ...(!enabled ? { acceptNewJobs: false } : {}) })} />
      </form>
    </Drawer>
  </ConsolePage>;
}
