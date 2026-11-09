import { useEffect, useRef, useState } from "react";
import { FileText, Pencil, RefreshCcw, Save } from "lucide-react";
import { apiPost } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";
import { Alert, Badge, Button, CodeEditor, Dialog, EmptyState, FormField, Skeleton, useToast } from "../../../ui/console";
import "./promptManage.css";

interface PromptItem {
  id: number;
  name: string;
  type: string;
  data: string;
  useData?: string | null;
  version?: string | number | null;
  updatedAt?: string | number | null;
  updateTime?: string | number | null;
}

const emptyPrompt: PromptItem = { id: 0, name: "", type: "", data: "" };

function normalizeVisiblePromptText(value: string) {
  return value
    .replace(/\u26a0\ufe0f?/g, "注意：")
    .replace(/\u274c/g, "错误：")
    .replace(/\u2705/g, "正确：")
    .replace(/[\u{1f300}-\u{1faff}\u2600-\u27bf]/gu, "");
}

function formatPromptDate(value?: string | number | null) {
  if (!value) return "未记录";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export default function PromptManage() {
  const { toast } = useToast();
  const promptEditorRef = useRef<HTMLTextAreaElement>(null);
  const savingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [data, setData] = useState<PromptItem[]>([]);
  const [visible, setVisible] = useState(false);
  const [promptData, setPromptData] = useState<PromptItem>(emptyPrompt);
  const [initialPromptText, setInitialPromptText] = useState("");

  useEffect(() => {
    void getPrompt();
  }, []);

  async function getPrompt() {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await apiPost<PromptItem[]>("/setting/promptManage/getPrompt", {});
      setData(Array.isArray(rows) ? rows.map((item) => ({
        id: Number(item.id),
        name: String(item.name || ""),
        type: String(item.type || ""),
        data: normalizeVisiblePromptText(String(item.data || "")),
      })) : []);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "系统提示词加载失败");
      setData([]);
    } finally {
      setLoading(false);
    }
  }

  function openEditor(value: PromptItem) {
    savingRef.current = false;
    setPromptData({ ...value });
    setInitialPromptText(value.data);
    setSaveError("");
    setVisible(true);
  }

  async function savePrompt() {
    if (savingRef.current || saving || !promptData.data.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      await apiPostWithStepUp("/setting/promptManage/updatePrompt", { id: promptData.id, data: promptData.data }, "legacy.content_config.manage");
      toast({ title: "保存成功", tone: "success" });
      await getPrompt();
      setInitialPromptText(promptData.data);
      setVisible(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "系统提示词保存失败";
      setSaveError(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const dirty = visible && promptData.data !== initialPromptText;

  return (
    <section className="promptManage" aria-labelledby="prompt-manage-heading">
      <div className="promptManageToolbar">
        <div>
          <h2 id="prompt-manage-heading">系统提示词列表</h2>
          <p>维护 AI 生产链路的系统提示词，保存后对全平台后续新任务生效。</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCcw size={16} aria-hidden="true" />}
          loading={loading}
          onClick={() => void getPrompt()}
        >
          刷新
        </Button>
      </div>

      {loadError ? (
        <Alert className="promptManageLoadAlert" tone="danger" title="系统提示词加载失败">
          <span>{loadError}</span>
          <Button variant="secondary" onClick={() => void getPrompt()}>重试</Button>
        </Alert>
      ) : null}

      {loading ? (
        <div className="promptManageSkeletons" role="status" aria-label="正在加载系统提示词">
          <Skeleton height="9rem" />
          <Skeleton height="9rem" />
        </div>
      ) : data.length ? (
        <div className="promptManageGrid" role="table" aria-label="系统提示词列表">
          <div className="promptManageTableHeader" role="row">
            <span role="columnheader">提示词</span>
            <span role="columnheader">适用链路</span>
            <span role="columnheader">版本</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">更新时间</span>
            <span role="columnheader">操作</span>
          </div>
          {data.map((value) => (
            <div
              key={value.id}
              className="promptManageCard"
              role="row"
            >
              <span className="promptManageIdentity" role="cell">
                <span className="promptManageCardIcon"><FileText size={15} aria-hidden="true" /></span>
                <span className="promptManageCardCopy">
                  <span className="promptManageCardTitle"><strong>{value.name}</strong></span>
                  <span className="promptManagePreview">{value.data || "暂无内容"}</span>
                </span>
              </span>
              <span className="promptManageTableCell" role="cell">{value.type || "全局链路"}</span>
              <span className="promptManageTableCell" role="cell">{value.version ? `v${value.version}` : value.useData ? "自定义" : "内置"}</span>
              <span role="cell"><Badge tone={value.useData ? "info" : "neutral"}>{value.useData ? "已自定义" : "系统默认"}</Badge></span>
              <span className="promptManageTableCell" role="cell">
                {value.updatedAt || value.updateTime ? formatPromptDate(value.updatedAt ?? value.updateTime) : value.useData ? "未记录" : "随系统发布"}
              </span>
              <span className="promptManageTableAction" role="cell">
                <Button
                  size="compact"
                  variant="secondary"
                  icon={<Pencil size={15} aria-hidden="true" />}
                  aria-label={`编辑系统提示词 ${value.name}`}
                  onClick={() => openEditor(value)}
                >
                  编辑
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : !loadError ? <EmptyState title="暂无系统提示词" description="平台尚未初始化可编辑的系统提示词。" /> : null}

      <Dialog
        open={visible}
        title={promptData.name ? `编辑系统提示词 · ${promptData.name}` : "编辑系统提示词"}
        description="保存后对全平台后续新任务生效；关闭前会保护未保存的修改。"
        size="xl"
        dirty={dirty}
        loading={saving}
        initialFocusRef={promptEditorRef}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setVisible(false);
            setSaveError("");
          }
        }}
        footer={(
          <div className="promptManageDialogActions">
            <Button
              type="submit"
              form="prompt-manage-editor-form"
              icon={<Save size={16} aria-hidden="true" />}
              loading={saving}
              disabled={!dirty || !promptData.data.trim()}
            >
              保存系统提示词
            </Button>
          </div>
        )}
      >
        <form
          id="prompt-manage-editor-form"
          className="promptManageEditor"
          onSubmit={(event) => {
            event.preventDefault();
            void savePrompt();
          }}
        >
          <div className="promptManageEditorMeta">
            <Badge tone="info">{promptData.type || "未分类"}</Badge>
            <span>{promptData.data.length.toLocaleString()} 字符</span>
          </div>
          {saveError ? <Alert tone="danger" title="系统提示词保存失败">{saveError}</Alert> : null}
          <FormField label="提示词内容" required help="使用纯文本维护；修改将影响全平台后续新任务。">
            <CodeEditor
              ref={promptEditorRef}
              language="text"
              minRows={18}
              value={promptData.data}
              disabled={saving}
              onChange={(event) => setPromptData((current) => ({ ...current, data: event.target.value }))}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="输入系统提示词..."
            />
          </FormField>
        </form>
      </Dialog>
    </section>
  );
}
