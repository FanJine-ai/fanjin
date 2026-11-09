import { useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  NumberInput,
  Section,
  Skeleton,
  Switch,
} from "../../../ui/console";
import type { EnhanceMatrixCell, EnhanceOverview } from "./types";
import { guFromMicros, microsFromGu, resLabel } from "./utils";
import { saveEnhancePricing } from "./api";

interface EnhanceSectionProps {
  overview: EnhanceOverview | null;
  loading: boolean;
  error: string;
  onSaved: () => void;
  onError: (message: string) => void;
}

interface EditingCell {
  sourceResolution: string;
  targetResolution: string;
  priceGu: number;
  disabled: boolean;
}

function cellKey(cell: Pick<EnhanceMatrixCell, "sourceResolution" | "targetResolution">) {
  return `${cell.sourceResolution}>${cell.targetResolution}`;
}

/** 独立的用户主动增强节点与 video_enhance 价目；不写入模型路由配方。 */
export function EnhanceSection({ overview, loading, error, onSaved, onError }: EnhanceSectionProps) {
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [saving, setSaving] = useState(false);

  const startEdit = (cell: EnhanceMatrixCell) => {
    setEditing({
      sourceResolution: cell.sourceResolution,
      targetResolution: cell.targetResolution,
      priceGu: cell.rule ? guFromMicros(cell.rule.unitPriceMicros) : 0,
      disabled: cell.rule ? cell.rule.disabled : false,
    });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.disabled && (!Number.isFinite(editing.priceGu) || editing.priceGu <= 0)) {
      onError("启用的价目单价必须大于 0 GU；停用时可设为 0。");
      return;
    }
    setSaving(true);
    try {
      await saveEnhancePricing({
        sourceResolution: editing.sourceResolution,
        targetResolution: editing.targetResolution,
        unitPriceMicros: microsFromGu(Math.max(0, editing.priceGu || 0)),
        unit: "second",
        disabled: editing.disabled,
      });
      setEditing(null);
      onSaved();
    } catch (err: any) {
      onError(err?.message || "价目保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="创作台画质增强"
      description="使用大模型版超分（最高 2K）。这里只配置用户主动增强的价格，不修改视频路由的超分配方。"
      icon={Sparkles}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {loading ? (
        <Skeleton height="10rem" />
      ) : !overview ? (
        error ? null : <Alert tone="warning">暂时没有可用的画质增强配置。</Alert>
      ) : (
        <div className="vfEnhance">
          <div className="vfEnhanceMatrix" role="table" aria-label="源→目标增强矩阵与价目">
            <div className="vfEnhanceMatrixRow vfEnhanceMatrixRow--head" role="row">
              <span role="columnheader">源 → 目标</span>
              <span role="columnheader">单价(GU/秒)</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">操作</span>
            </div>
            {overview.matrix.map((cell) => {
              const key = cellKey(cell);
              const isEditing = editing !== null && cellKey(editing) === key;
              return (
                <div className="vfEnhanceMatrixRow" role="row" key={key}>
                  <span role="cell" className="vfEnhancePair">
                    {resLabel(cell.sourceResolution)} → {resLabel(cell.targetResolution)}
                  </span>
                  {isEditing ? (
                    <>
                      <span role="cell">
                        <NumberInput
                          value={editing.priceGu}
                          min={0}
                          step={1}
                          aria-label="单价(GU/秒)"
                          onValueChange={(value) => setEditing({ ...editing, priceGu: value ?? 0 })}
                        />
                      </span>
                      <span role="cell">
                        <Switch
                          checked={!editing.disabled}
                          onCheckedChange={(checked) => setEditing({ ...editing, disabled: !checked })}
                          label={editing.disabled ? "已停用" : "启用中"}
                        />
                      </span>
                      <span role="cell" className="vfEnhanceActions">
                        <Button size="compact" onClick={() => void save()} loading={saving}>保存</Button>
                        <Button size="compact" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>取消</Button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span role="cell" className="vfEnhancePrice">
                        {cell.rule && !cell.rule.disabled ? `${guFromMicros(cell.rule.unitPriceMicros)} GU/秒` : "未配置"}
                      </span>
                      <span role="cell">
                        {cell.rule ? (
                          <Badge tone={cell.rule.disabled ? "neutral" : "success"}>{cell.rule.disabled ? "已停用" : "生效中"}</Badge>
                        ) : (
                          <Badge tone="warning">待配置</Badge>
                        )}
                      </span>
                      <span role="cell" className="vfEnhanceActions">
                        <Button size="compact" variant="secondary" onClick={() => startEdit(cell)}>
                          {cell.rule ? "编辑价目" : "配置价目"}
                        </Button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="vfEnhancePool">
            <h3>独立超分服务（只读）</h3>
            <p className="vfEnhancePoolCopy">
              凭据统一在 <Link to="/fjadmin/media-services">媒体服务</Link> 管理。本页只影响用户主动增强；视频路由需要单独绑定服务。共用服务故障时，两处都会受到影响。
            </p>
            {overview.upscaleChannels.length === 0 ? (
              <Alert tone="warning">尚未配置超分服务，请先在媒体服务页添加 MediaKit API Key。</Alert>
            ) : (
              <ul className="vfChannelPool">
                {overview.upscaleChannels.map((channel) => (
                  <li key={channel.id}>
                    <strong>{channel.name}</strong>
                    <span>{channel.provider}</span>
                    <span className="vfChannelPoolModels">
                      大模型版超分
                    </span>
                    <Badge tone={channel.disabled ? "neutral" : channel.healthStatus === "ok" ? "success" : channel.healthStatus ? "warning" : "info"}>
                      {channel.disabled ? "已停用" : channel.healthStatus || "未探测"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
