import { useMemo, useState } from "react";
import { ArrowRight, Boxes, RefreshCcw, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  ConsolePage,
  DataTable,
  FilterBar,
  FormField,
  Input,
  MetricStrip,
  Select,
  type DataTableColumn,
} from "../../../ui/console";
import { useModelOperations } from "./hooks";
import { ModelFlowNav } from "./ModelFlowNav";
import { endpointLabels, type ModelPoolItem } from "./types";
import "./styles.css";

function HealthBadge({ health }: { health: ModelPoolItem["health"] }) {
  const config = {
    healthy: { tone: "success" as const, label: "健康" },
    degraded: { tone: "warning" as const, label: "降级" },
    unhealthy: { tone: "danger" as const, label: "不可用" },
    unknown: { tone: "neutral" as const, label: "未检查" },
  }[health];
  return <Badge tone={config.tone}>{config.label}</Badge>;
}

export default function ModelPoolPage() {
  const navigate = useNavigate();
  const state = useModelOperations();
  const [query, setQuery] = useState("");
  const [endpointType, setEndpointType] = useState("");
  const [routeStatus, setRouteStatus] = useState("");
  const [health, setHealth] = useState("");
  const endpoints = useMemo(() => [...new Set(state.pool.map((item) => item.endpointType))].sort(), [state.pool]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.pool.filter((item) => (
      (!needle || [item.upstreamModel, item.channelName, item.provider].some((value) => value.toLowerCase().includes(needle)))
      && (!endpointType || item.endpointType === endpointType)
      && (!health || item.health === health)
      && (!routeStatus || (routeStatus === "routed" ? item.routedGroupKeys.length > 0 : item.routedGroupKeys.length === 0))
    ));
  }, [endpointType, health, query, routeStatus, state.pool]);
  const routed = state.pool.filter((item) => item.routedGroupKeys.length > 0).length;
  const healthy = state.pool.filter((item) => item.health === "healthy").length;

  const columns = useMemo<DataTableColumn<ModelPoolItem>[]>(() => [
    {
      id: "model", header: "上游模型", priority: "primary", sortable: true, minWidth: "220px",
      sortValue: (row) => row.upstreamModel,
      cell: (row) => <div className="modelOpsIdentity"><strong>{row.upstreamModel}</strong><code>{row.provider}</code></div>,
    },
    {
      id: "capability", header: "能力", priority: "primary", sortable: true,
      sortValue: (row) => row.endpointType,
      cell: (row) => <div className="modelOpsIdentity"><strong>{endpointLabels[row.endpointType] || row.endpointType}</strong><span>{row.endpointType}</span></div>,
    },
    { id: "channel", header: "供应商渠道", priority: "secondary", sortable: true, accessor: "channelName" },
    { id: "health", header: "健康", priority: "primary", sortable: true, sortValue: (row) => row.health, cell: (row) => <HealthBadge health={row.health} /> },
    {
      id: "routing", header: "路由状态", priority: "primary", sortable: true,
      sortValue: (row) => row.routedGroupKeys.length,
      cell: (row) => row.routedGroupKeys.length
        ? <Badge tone="success">已加入 {row.routedGroupKeys.length} 个路由</Badge>
        : <Badge tone="warning">未配置路由</Badge>,
    },
    { id: "scope", header: "范围", priority: "detail", cell: (row) => row.scope === "workspace" ? `工作区 · ${row.workspaceId}` : "平台" },
    {
      id: "actions", header: "操作", headerLabel: "行操作", priority: "primary", hideable: false,
      cell: (row) => (
        <Button
          size="compact"
          variant={row.routedGroupKeys.length ? "secondary" : "primary"}
          icon={<ArrowRight size={15} />}
          iconPosition="end"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/fjadmin/model-management?sourcePoolId=${encodeURIComponent(row.poolId)}`);
          }}
        >
          {row.routedGroupKeys.length ? "再建路由" : "配置路由"}
        </Button>
      ),
    },
  ], [navigate]);

  return (
    <ConsolePage
      breadcrumbs={[{ label: "模型管理" }, { label: "模型池" }]}
      title="模型池"
      description="渠道发现的上游模型先汇入这里；只有完成模型路由和首次定价后，才会进入创作台、中转站与模型广场。"
      primaryAction={<Button variant="secondary" icon={<RefreshCcw size={16} />} loading={state.loading} onClick={state.reload}>刷新</Button>}
      layoutWidth="dashboard"
    >
      <ModelFlowNav active="pool" />
      <MetricStrip metrics={[
        { id: "total", label: "模型池项", value: state.loading ? "-" : state.pool.length.toLocaleString(), hint: "按渠道与上游模型统计" },
        { id: "healthy", label: "健康来源", value: state.loading ? "-" : healthy.toLocaleString(), hint: "最近检查可用", tone: "positive" },
        { id: "routed", label: "已加入路由", value: state.loading ? "-" : routed.toLocaleString(), hint: "可继续被多个逻辑模型复用" },
        { id: "waiting", label: "待配置", value: state.loading ? "-" : Math.max(0, state.pool.length - routed).toLocaleString(), hint: "尚未对外发布" },
      ]} />
      <FilterBar actions={<Button icon={<Search size={16} />}>筛选</Button>}>
        <FormField label="模型或渠道" optionalLabel={null} className="modelOpsFilter--wide">
          <Input value={query} placeholder="搜索模型、供应商或渠道" onChange={(event) => setQuery(event.currentTarget.value)} />
        </FormField>
        <FormField label="能力" optionalLabel={null}>
          <Select value={endpointType} onChange={(event) => setEndpointType(event.currentTarget.value)}>
            <option value="">全部能力</option>
            {endpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpointLabels[endpoint] || endpoint}</option>)}
          </Select>
        </FormField>
        <FormField label="健康" optionalLabel={null}>
          <Select value={health} onChange={(event) => setHealth(event.currentTarget.value)}>
            <option value="">全部状态</option><option value="healthy">健康</option><option value="degraded">降级</option><option value="unhealthy">不可用</option><option value="unknown">未检查</option>
          </Select>
        </FormField>
        <FormField label="路由状态" optionalLabel={null}>
          <Select value={routeStatus} onChange={(event) => setRouteStatus(event.currentTarget.value)}>
            <option value="">全部状态</option><option value="unrouted">待配置</option><option value="routed">已加入路由</option>
          </Select>
        </FormField>
      </FilterBar>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.poolId}
        ariaLabel="模型池列表"
        loading={state.loading}
        error={state.error || undefined}
        onRetry={state.reload}
        emptyState={<div className="modelOpsEmpty"><Boxes size={22} /><strong>模型池暂无匹配项</strong><span>请先在供应商渠道中完成模型发现并保存渠道。</span></div>}
        defaultSort={{ columnId: "model", direction: "ascending" }}
      />
    </ConsolePage>
  );
}
