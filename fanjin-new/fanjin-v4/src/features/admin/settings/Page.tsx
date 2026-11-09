import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  CreditCard,
  Edit3,
  History,
  KeyRound,
  Megaphone,
  Power,
  PowerOff,
  RefreshCcw,
  RotateCcw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import AgentConfog from "../../../components/setting/components/agentConfog";
import {
  Badge,
  Button,
  ConfirmDialog,
  ConsolePage,
  DataTable,
  Drawer,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
  type DataTableColumn,
} from "../../../ui/console";
import { updatePlatformSetting } from "./api";
import { usePlatformSettings } from "./hooks";
import { OAuthProviderSettings } from "./OAuthProviderSettings";
import { SettingDrawer } from "./SettingDrawer";
import {
  formatSettingValue,
  isCustomizedSetting,
  isSecretSetting,
  type PlatformSettingItem,
  type PlatformSettingSection,
  type PlatformSettingValue,
} from "./types";
import "./settings.css";

function SectionIcon({ section }: { section: PlatformSettingSection }) {
  const identity = `${section.id} ${section.title}`.toLocaleLowerCase();
  if (/security|auth|安全|登录|风控/.test(identity)) return <ShieldCheck aria-hidden="true" size={15} />;
  if (/billing|finance|计费|账单|额度|财务/.test(identity)) return <CreditCard aria-hidden="true" size={15} />;
  if (/relay|route|gateway|中转|路由|网关/.test(identity)) return <Route aria-hidden="true" size={15} />;
  if (/system|general|系统|通用/.test(identity)) return <Settings2 aria-hidden="true" size={15} />;
  return <SlidersHorizontal aria-hidden="true" size={15} />;
}

function SettingValue({ item }: { item: PlatformSettingItem }) {
  if (isSecretSetting(item)) {
    return (
      <div className="settingsValueCell" data-kind="secret">
        <Badge
          icon={<KeyRound size={13} />}
          tone={item.configured ? "success" : "neutral"}
        >
          {item.configured ? "已安全配置" : "未配置"}
        </Badge>
      </div>
    );
  }

  if (item.type === "boolean") {
    return (
      <div className="settingsValueCell" data-kind="boolean">
        <Badge
          icon={item.value ? <Power size={13} /> : <PowerOff size={13} />}
          tone={item.value ? "success" : "neutral"}
        >
          {formatSettingValue(item, item.value)}
        </Badge>
      </div>
    );
  }

  const label = formatSettingValue(item, item.value);
  return (
    <div className="settingsValueCell" data-kind={item.type}>
      <Tooltip>
        <TooltipTrigger className="settingsValueText">{label}</TooltipTrigger>
        <TooltipContent align="start">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SystemSettingsPage() {
  const data = usePlatformSettings();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<PlatformSettingItem | null>(null);
  const [value, setValue] = useState<PlatformSettingValue>("");
  const [initialValue, setInitialValue] = useState<PlatformSettingValue>("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [resetItem, setResetItem] = useState<PlatformSettingItem | null>(null);
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentConfigDirty, setAgentConfigDirty] = useState(false);
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);
  const [noticeDraft, setNoticeDraft] = useState("");
  const [noticeSaving, setNoticeSaving] = useState(false);
  const [noticeError, setNoticeError] = useState("");
  const savingRef = useRef(false);
  const resettingRef = useRef(false);
  const noticeSavingRef = useRef(false);

  useEffect(() => {
    if (data.sections.length && !data.sections.some((section) => section.id === activeSection)) {
      setActiveSection(data.sections[0].id);
    }
  }, [activeSection, data.sections]);

  const sectionMap = useMemo(
    () => new Map(data.sections.map((section) => [section.id, section])),
    [data.sections],
  );
  const sectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    data.items.forEach((item) => counts.set(item.section, (counts.get(item.section) || 0) + 1));
    return counts;
  }, [data.items]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(() => {
    return data.items.filter((item) => {
      const matchesQuery = !normalizedQuery || [item.label, item.key, item.description]
        .some((part) => part.toLocaleLowerCase().includes(normalizedQuery));
      return matchesQuery && (normalizedQuery ? true : item.section === activeSection);
    });
  }, [activeSection, data.items, normalizedQuery]);
  const selectedSection = sectionMap.get(activeSection);
  const noticeItem = useMemo(
    () => data.items.find((item) => item.key === "platform.site.notice"),
    [data.items],
  );
  const noticeValue = String(noticeItem?.value ?? "");
  const normalizedNoticeDraft = noticeDraft.trim();
  const normalizedNoticeValue = noticeValue.trim();
  const noticeDirty = normalizedNoticeDraft !== normalizedNoticeValue;

  useEffect(() => {
    if (!noticeSavingRef.current) {
      setNoticeDraft(noticeValue);
      setNoticeError("");
    }
  }, [noticeValue]);

  const openEditor = useCallback((item: PlatformSettingItem) => {
    const next = isSecretSetting(item) ? "" : item.value;
    setEditor(item);
    setValue(next);
    setInitialValue(next);
    setFormError("");
  }, []);

  const save = async () => {
    if (!editor || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFormError("");
    try {
      await updatePlatformSetting(editor.key, value);
      toast({ title: "平台设置已保存", message: editor.label, tone: "success" });
      await data.applyReload();
      setEditor(null);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "设置保存失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveNotice = useCallback(async (nextNotice: string) => {
    if (!noticeItem || noticeSavingRef.current) return;
    noticeSavingRef.current = true;
    setNoticeSaving(true);
    setNoticeError("");
    try {
      await updatePlatformSetting(noticeItem.key, nextNotice.trim());
      toast({
        title: nextNotice.trim() ? "平台公告已发布" : "平台公告已清空",
        message: nextNotice.trim() ? "前台通知中心会即时读取这条公告。" : "前台通知中心不再展示系统公告。",
        tone: "success",
      });
      await data.applyReload();
    } catch (caught) {
      setNoticeError(caught instanceof Error ? caught.message : "平台公告保存失败");
    } finally {
      noticeSavingRef.current = false;
      setNoticeSaving(false);
    }
  }, [data, noticeItem, toast]);

  const columns = useMemo<DataTableColumn<PlatformSettingItem>[]>(() => [
    {
      id: "setting",
      header: "设置项",
      priority: "primary",
      sortable: true,
      sortValue: (item) => item.label,
      minWidth: "230px",
      className: "settingsSettingColumn",
      cell: (item) => (
        <div className="settingsNameCell">
          <strong>{item.label}</strong>
          <span>{item.description}</span>
          <div className="settingsNameMeta">
            {normalizedQuery && <span>{sectionMap.get(item.section)?.title || item.section}</span>}
            <code>{item.key}</code>
          </div>
        </div>
      ),
    },
    {
      id: "value",
      header: "当前状态",
      priority: "primary",
      minWidth: "150px",
      className: "settingsValueColumn",
      cell: (item) => <SettingValue item={item} />,
    },
    {
      id: "source",
      header: "配置来源",
      priority: "secondary",
      minWidth: "86px",
      cell: (item) => (
        <Badge tone={isCustomizedSetting(item) ? "info" : "neutral"}>
          {isCustomizedSetting(item) ? "自定义" : "默认值"}
        </Badge>
      ),
    },
    {
      id: "restart",
      header: "生效方式",
      priority: "detail",
      minWidth: "100px",
      cell: (item) => item.restartRequired ? (
        <Badge tone="warning">重启生效</Badge>
      ) : (
        <span className="settingsImmediateState"><Zap aria-hidden="true" size={13} />即时生效</span>
      ),
    },
    {
      id: "actions",
      header: "操作",
      priority: "primary",
      hideable: false,
      minWidth: "136px",
      className: "settingsActionsColumn",
      cell: (item) => (
        <div className="settingsRowActions">
          <Button
            variant="secondary"
            size="compact"
            icon={<Edit3 aria-hidden="true" size={14} />}
            onClick={() => openEditor(item)}
          >
            编辑
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button
                  variant="ghost"
                  size="compact"
                  icon={<ChevronDown aria-hidden="true" size={14} />}
                  iconPosition="end"
                  aria-label={`更多操作：${item.label}`}
                />
              )}
            >
              更多
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isSecretSetting(item) ? (
                <Tooltip>
                  <TooltipTrigger render={<DropdownMenuItem disabled tone="danger" />}>
                    <RotateCcw aria-hidden="true" size={16} />
                    恢复默认
                  </TooltipTrigger>
                  <TooltipContent align="end">敏感设置只能输入新值替换，不能通过默认值清空</TooltipContent>
                </Tooltip>
              ) : (
                <DropdownMenuItem
                  disabled={!isCustomizedSetting(item)}
                  tone="danger"
                  onClick={() => setResetItem(item)}
                >
                  <RotateCcw aria-hidden="true" size={16} />
                  恢复默认
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ], [normalizedQuery, openEditor, sectionMap]);

  const configuredCount = data.items.filter(isCustomizedSetting).length;
  const restartCount = data.items.filter((item) => item.restartRequired).length;
  const sensitiveCount = data.items.filter(isSecretSetting).length;
  const scopedConfiguredCount = visibleItems.filter(isCustomizedSetting).length;
  const scopedRestartCount = visibleItems.filter((item) => item.restartRequired).length;

  return (
    <ConsolePage
      title="平台设置"
      description="按治理域维护全局开关、风控、计费与系统参数。"
      primaryAction={(
        <Button icon={<Bot size={16} aria-hidden="true" />} onClick={() => setAgentConfigOpen(true)}>
          Agent 角色配置
        </Button>
      )}
      layoutWidth="dashboard"
    >
      <aside className="settingsGovernanceBar" aria-label="设置治理概况">
        <dl className="settingsGovernanceStats">
          <div><dt>设置项</dt><dd>{data.loading ? "-" : data.items.length}</dd></div>
          <div><dt>自定义</dt><dd>{data.loading ? "-" : configuredCount}</dd></div>
          <div><dt>敏感项</dt><dd>{data.loading ? "-" : sensitiveCount}</dd></div>
          <div data-tone={restartCount ? "warning" : "neutral"}><dt>需重启</dt><dd>{data.loading ? "-" : restartCount}</dd></div>
        </dl>
        <div className="settingsAuditNote">
          <History aria-hidden="true" size={16} />
          <span><strong>变更留痕</strong>保存与恢复默认均写入 changedKeys</span>
          <Button
            variant="ghost"
            size="compact"
            onClick={() => navigate("/fjadmin/audit-logs")}
          >
            审计日志
          </Button>
        </div>
      </aside>

      <section className="settingsNoticePublisher" aria-label="平台公告发布">
        <header className="settingsNoticePublisherHeader">
          <div className="settingsNoticePublisherTitle">
            <span className="settingsNoticePublisherIcon"><Megaphone aria-hidden="true" size={15} /></span>
            <div>
              <h2>平台公告</h2>
              <p>发布维护、价格、模型能力变化等面向用户的通知；前台通知中心即时读取。</p>
            </div>
          </div>
          <Badge tone={normalizedNoticeValue ? "info" : "neutral"}>
            {normalizedNoticeValue ? "公告展示中" : "暂无公告"}
          </Badge>
        </header>
        <div className="settingsNoticePublisherBody">
          <label className="settingsNoticeEditor">
            <span>公告内容</span>
            <textarea
              value={noticeDraft}
              placeholder="例如：今晚 23:30-23:50 进行模型路由维护，期间部分生成任务可能延迟。"
              rows={3}
              maxLength={500}
              disabled={!noticeItem || data.loading || noticeSaving}
              onChange={(event) => setNoticeDraft(event.currentTarget.value)}
            />
          </label>
          <aside className="settingsNoticePreview" aria-label="前台通知预览">
            <span>前台预览</span>
            <p>{normalizedNoticeDraft || "当前没有平台公告，通知中心只展示个人通知。"}</p>
          </aside>
        </div>
        <footer className="settingsNoticePublisherFooter">
          <span className="settingsNoticeMeta" role="status">
            {noticeError || (noticeDirty ? "有未发布修改" : normalizedNoticeValue ? "公告已同步到前台通知中心" : "公告为空")}
          </span>
          <div className="settingsNoticeActions">
            <Button
              variant="ghost"
              size="compact"
              disabled={!noticeItem || noticeSaving || !normalizedNoticeValue}
              onClick={() => {
                setNoticeDraft("");
                void saveNotice("");
              }}
            >
              清空公告
            </Button>
            <Button
              size="compact"
              icon={<Megaphone aria-hidden="true" size={14} />}
              loading={noticeSaving}
              disabled={!noticeItem || data.loading || !noticeDirty}
              onClick={() => void saveNotice(noticeDraft)}
            >
              发布公告
            </Button>
          </div>
        </footer>
      </section>

      <section className="settingsWorkbench" aria-label="平台设置工作台">
        <header className="settingsWorkbenchToolbar">
          <div className="settingsSearchGroup">
            <Input
              aria-label="搜索平台设置"
              placeholder="搜索名称、说明或设置键"
              startIcon={<Search size={15} />}
              endAdornment={query ? (
                <IconButton
                  aria-label="清除设置搜索"
                  icon={<X aria-hidden="true" size={15} />}
                  size="compact"
                  onClick={() => setQuery("")}
                />
              ) : undefined}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <span className="settingsSearchSummary" role="status">
              {normalizedQuery ? `跨全部分区找到 ${visibleItems.length} 项` : `当前分区 ${visibleItems.length} 项`}
            </span>
          </div>
          <Button
            variant="secondary"
            size="compact"
            icon={<RefreshCcw size={15} />}
            loading={data.loading}
            onClick={() => void data.reload()}
          >
            刷新
          </Button>
        </header>

        <div className="settingsWorkbenchBody">
          <nav className="settingsSectionNav" aria-label="平台设置分区">
            <div className="settingsSectionNavHeading">
              <span>治理分区</span>
              <span>{data.sections.length}</span>
            </div>
            <div className="settingsSectionNavList">
              {data.sections.map((section) => {
                const selected = !normalizedQuery && section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    className="settingsSectionNavItem"
                    onClick={() => {
                      setActiveSection(section.id);
                      setQuery("");
                    }}
                  >
                    <span className="settingsSectionNavIcon"><SectionIcon section={section} /></span>
                    <span className="settingsSectionNavCopy">
                      <strong>{section.title}</strong>
                      <span>{section.description}</span>
                    </span>
                    <span className="settingsSectionCount">{sectionCounts.get(section.id) || 0}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="settingsTablePane">
            <header className="settingsSectionHeader">
              <div>
                <span className="settingsSectionEyebrow">{normalizedQuery ? "全部治理域" : "当前治理域"}</span>
                <h2>{normalizedQuery ? "搜索结果" : selectedSection?.title || "平台设置"}</h2>
                <p>
                  {normalizedQuery
                    ? `名称、说明或设置键包含“${query.trim()}”的设置项。`
                    : selectedSection?.description || "选择左侧治理分区查看设置。"}
                </p>
              </div>
              <div className="settingsSectionFacts" aria-label="当前列表概况">
                <span><strong>{visibleItems.length}</strong> 项</span>
                <span><strong>{scopedConfiguredCount}</strong> 自定义</span>
                {scopedRestartCount > 0 && <span data-tone="warning"><strong>{scopedRestartCount}</strong> 需重启</span>}
              </div>
            </header>
            {!normalizedQuery && activeSection === "auth" && (
              <OAuthProviderSettings
                items={data.items}
                disabled={data.loading}
                onSaved={() => data.applyReload()}
              />
            )}
            <DataTable
              className="settingsDataTable"
              rows={visibleItems}
              columns={columns}
              getRowId={(item) => item.key}
              ariaLabel="平台设置列表"
              caption={normalizedQuery ? "跨分区平台设置搜索结果" : `${selectedSection?.title || "平台"}设置列表`}
              loading={data.loading}
              error={data.error || undefined}
              onRetry={() => void data.reload()}
              emptyState={normalizedQuery ? "没有匹配的设置项" : "该分区暂无设置项"}
              onRowClick={openEditor}
              getRowAriaLabel={(item) => `编辑平台设置 ${item.label}`}
              columnTools="hidden"
              defaultPageSize={50}
              pageSizeOptions={[50, 100]}
              scrollMode="page"
            />
          </div>
        </div>
      </section>

      <SettingDrawer
        open={Boolean(editor)}
        item={editor}
        sectionTitle={editor ? sectionMap.get(editor.section)?.title : undefined}
        value={value}
        initialValue={initialValue}
        saving={saving}
        error={formError}
        onValueChange={setValue}
        onSave={() => void save()}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(resetItem)}
        title="恢复默认设置"
        description={resetItem
          ? `将「${resetItem.label}」恢复为默认值“${formatSettingValue(resetItem, resetItem.defaultValue)}”${resetItem.restartRequired ? "，保存后还需重启相关服务" : ""}。此操作会写入变更审计。`
          : "该设置将恢复为默认值，并写入变更审计。"}
        confirmLabel="恢复默认"
        tone="danger"
        onCancel={() => setResetItem(null)}
        onConfirm={async () => {
          if (!resetItem || resettingRef.current) return false;
          resettingRef.current = true;
          try {
            await updatePlatformSetting(resetItem.key, resetItem.defaultValue);
            toast({ title: "已恢复默认值", message: resetItem.label, tone: "success" });
            await data.reload();
            return true;
          } finally {
            resettingRef.current = false;
          }
        }}
        onConfirmError={(caught) => toast({
          title: "恢复默认失败",
          message: caught instanceof Error ? caught.message : "请稍后重试",
          tone: "danger",
        })}
      />
      <Drawer
        open={agentConfigOpen}
        title="Agent 角色运行配置"
        description="维护六类角色的版本化 Prompt、Skill、模型 Profile 与运行参数。"
        size="min(960px, 100vw)"
        dirty={agentConfigDirty}
        loading={agentConfigSaving}
        closeGuardTitle="放弃 Agent 配置修改？"
        closeGuardDescription="尚未保存的角色草稿会被丢弃，服务端配置不会改变。"
        onOpenChange={(open) => {
          if (!open && !agentConfigSaving) setAgentConfigOpen(false);
        }}
      >
        <AgentConfog onDirtyChange={setAgentConfigDirty} onSavingChange={setAgentConfigSaving} />
      </Drawer>
    </ConsolePage>
  );
}
