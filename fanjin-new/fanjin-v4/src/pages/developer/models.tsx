import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import { useState, useMemo } from "react";
import { Boxes, Search } from "lucide-react";
import { Badge, Button, ConsolePage, DataTable, FilterBar, Input, Select, Section, type DataTableColumn } from "../../ui/console";
import { statusLabel, statusTone } from "./developerSnapshot";
import { type CatalogItem, useDeveloperCatalog } from "./useDeveloperCatalog";

type ModelRow = {
  id: string;
  model: string;
  name: string;
  endpointType: string;
  status: string;
  capabilities: string[];
  price: string;
};

const endpointLabels: Record<string, string> = {
  text: "文本生成",
  embedding: "文本向量",
  multimodal_embedding: "多模态向量",
  transcription: "语音转写",
  tts: "语音合成",
  rerank: "结果排序",
  video_generation: "视频生成",
  image_generation: "图片生成",
};

function publicCapabilities(item: CatalogItem): string[] {
  if (item.endpointType === "video_generation") {
    return item.resolutions.map((resolution) => (
      resolution === item.defaultResolution ? `${resolution} 默认` : resolution
    ));
  }
  if (item.endpointType === "image_generation") {
    return item.qualities.map((quality) => (
      quality === item.defaultQuality ? `${quality} 默认` : quality
    ));
  }
  return [endpointLabels[item.endpointType] || item.endpointType];
}

function publicPrice(item: CatalogItem): string {
  if (!item.pricing) return "";
  const amount = item.pricing.unit === "token"
    ? item.pricing.unitPriceMicros * 1_000_000 / (item.pricing.currency === "GU" ? GU_MICROS_PER_GU : 1_000_000)
    : item.pricing.unitPriceMicros / (item.pricing.currency === "GU" ? GU_MICROS_PER_GU : 1_000_000);
  const unit = item.pricing.unit === "token" ? "百万 Token"
    : item.pricing.unit === "second" ? "秒" : item.pricing.unit;
  const basis = item.endpointType === "video_generation" && item.pricing.unit === "second"
    ? "（按输出视频时长计费）" : "";
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${item.pricing.currency} / ${unit}${basis}`;
}

export default function ApiModelsPage() {
  const { loading, error, catalog, retry } = useDeveloperCatalog();
  const [searchInput, setSearchInput] = useState("");
  const [endpointFilter, setEndpointFilter] = useState<string>("");

  const filteredModels = useMemo(() => {
    let filtered = catalog.items;

    if (searchInput) {
      const search = searchInput.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.model.toLowerCase().includes(search) ||
          m.name.toLowerCase().includes(search) ||
          m.endpointType.toLowerCase().includes(search)
      );
    }

    if (endpointFilter) {
      filtered = filtered.filter((m) => m.endpointType === endpointFilter);
    }

    return filtered;
  }, [catalog.items, searchInput, endpointFilter]);

  const endpointTypes = useMemo(() => {
    const types = new Set(catalog.items.map((m) => m.endpointType).filter(Boolean));
    return Array.from(types);
  }, [catalog.items]);

  const modelColumns: DataTableColumn<ModelRow>[] = [
    {
      id: "model",
      header: "模型 ID",
      accessor: "model",
      priority: "primary",
      hideable: false,
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-sm font-medium">{row.model}</span>
          {row.name !== row.model && (
            <span className="text-xs text-[var(--cui-text-muted)]">{row.name}</span>
          )}
        </div>
      ),
    },
    {
      id: "endpointType",
      header: "能力类型",
      accessor: "endpointType",
      priority: "secondary",
      hideable: false,
      cell: (row) => endpointLabels[row.endpointType] || row.endpointType,
    },
    {
      id: "capabilities",
      header: "公开能力与售价",
      priority: "primary",
      hideable: false,
      cell: (row) => (
        <div className="flex max-w-[28rem] flex-col gap-1.5">
          <div className="flex flex-wrap gap-1">
            {row.capabilities.map((capability) => (
              <Badge key={capability} tone="neutral">{capability}</Badge>
            ))}
          </div>
          <span className="text-xs text-[var(--cui-text-muted)]">
            {row.price || "价格未公开"}
          </span>
        </div>
      ),
    },
    {
      id: "status",
      header: "状态",
      accessor: "status",
      priority: "primary",
      hideable: false,
      cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>,
    },
  ];

  const rows: ModelRow[] = filteredModels.map((item) => ({
    id: `${item.model}:${item.endpointType}`,
    model: item.model,
    name: item.name,
    endpointType: item.endpointType,
    status: item.status,
    capabilities: publicCapabilities(item),
    price: publicPrice(item),
  }));

  return (
    <ConsolePage eyebrow="Developer API" title="模型与能力" description="发布目标的模型名称、公开能力、售价与可调用状态会自动同步到这里。">
      <Section title="模型目录" icon={Boxes}>
        <FilterBar ariaLabel="模型筛选" className="developerModelFilters">
          <Input
            aria-label="搜索模型"
            startIcon={<Search size={16} />}
            placeholder="搜索模型名称、能力类型…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Select aria-label="能力类型" value={endpointFilter} onChange={(event) => setEndpointFilter(event.target.value)}>
            <option value="">全部能力</option>
            {endpointTypes.map((type) => <option key={type} value={type}>{endpointLabels[type] || type}</option>)}
          </Select>
        </FilterBar>

        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-[var(--cui-text-muted)]">
            {error
              ? "模型目录不可用，未显示任何缓存或演示数据。"
              : loading
                ? "正在读取当前工作区模型目录。"
                : (
                  <>
                    显示 <span className="font-semibold text-[var(--cui-text)]">{rows.length}</span> / {catalog.summary.total} 个模型
                    （<span className="text-[var(--cui-success-text)]">{catalog.summary.active} 可用</span>
                    {" / "}
                    <span className="text-[var(--cui-warning-text)]">{catalog.summary.unavailable} 暂不可用</span>）
                  </>
                )}
          </span>
          {(searchInput || endpointFilter) && (
            <Button variant="ghost"
              onClick={() => {
                setSearchInput("");
                setEndpointFilter("");
              }}
            >
              清除筛选
            </Button>
          )}
        </div>

        <DataTable
          rows={rows}
          columns={modelColumns}
          getRowId={(row) => row.id}
          caption="当前工作区模型目录"
          ariaLabel="模型与能力目录"
          loading={loading}
          error={error || undefined}
          onRetry={retry}
          emptyState={
            searchInput || endpointFilter
              ? "没有找到匹配的模型，请尝试调整筛选条件。"
              : "暂无模型目录；后端返回模型后会显示在这里。"
          }
          getRowAriaLabel={(row) => `${row.name}，模型 ID ${row.model}，状态 ${statusLabel(row.status)}`}
          defaultPageSize={20}
        />
      </Section>
    </ConsolePage>
  );
}
