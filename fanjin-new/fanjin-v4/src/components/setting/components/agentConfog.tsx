import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Database,
  KeyRound,
  LockKeyhole,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { ApiError } from "../../../api/http";
import {
  getAgentRoleConfigs,
  issueAgentRoleConfigStepUp,
  updateAgentRoleConfig,
} from "../../../features/agent-runtime/api";
import type {
  AgentRoleConfigListResult,
  AgentRoleRuntimeConfig,
  AgentRuntimeConfigRef,
  AgentRuntimeModelProfileRegistryItem,
  AgentRuntimeRole,
} from "../../../features/agent-runtime/types";
import { useAuthStore } from "../../../stores/authStore";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  FormField,
  Input,
  NumberInput,
  Select,
  Skeleton,
  Switch,
  Tabs,
  useToast,
} from "../../../ui/console";
import { isPlatformAdmin } from "../../../utils/permissions";
import "./agentConfig.css";

type AgentRoleDraft = {
  role: AgentRuntimeRole;
  promptRef: AgentRuntimeConfigRef;
  skillRefs: AgentRuntimeConfigRef[];
  modelProfileRef: AgentRuntimeConfigRef;
  modelAliasOverride: string;
  temperatureMilli: number | null;
  maxOutputTokens: number | null;
  enabled: boolean;
  revision: number;
};

type DraftMap = Partial<Record<AgentRuntimeRole, AgentRoleDraft>>;

type AgentConfogProps = {
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
};

const ROLE_COPY: Record<AgentRuntimeRole, { label: string; description: string }> = {
  main: { label: "主控", description: "理解目标、规划流程并协调专职角色。" },
  writer: { label: "编剧", description: "负责剧本、文案与叙事草稿。" },
  visual: { label: "视觉", description: "负责视觉设定与图像任务提案。" },
  storyboard: { label: "分镜", description: "负责镜头结构、节奏与分镜草稿。" },
  executor: { label: "执行", description: "执行已验证、已授权的生成规格。" },
  reviewer: { label: "审核", description: "基于证据检查质量并输出审核报告。" },
};

const RUNTIME_SWITCH_COPY: Record<"runtime" | "worker" | "model" | "tools", string> = {
  runtime: "Runtime",
  worker: "Worker",
  model: "模型执行",
  tools: "工具调用",
};

function cloneRef(ref: AgentRuntimeConfigRef): AgentRuntimeConfigRef {
  return { key: ref.key, version: ref.version };
}

function draftFromConfig(config: AgentRoleRuntimeConfig): AgentRoleDraft {
  return {
    role: config.role,
    promptRef: cloneRef(config.promptRef),
    skillRefs: config.skillRefs.map(cloneRef),
    modelProfileRef: cloneRef(config.modelProfileRef),
    modelAliasOverride: config.modelAliasOverride ?? "",
    temperatureMilli: config.temperatureMilli,
    maxOutputTokens: config.maxOutputTokens,
    enabled: config.enabled,
    revision: config.revision,
  };
}

function draftMapFromConfigs(configs: AgentRoleRuntimeConfig[]): DraftMap {
  return Object.fromEntries(configs.map((config) => [config.role, draftFromConfig(config)])) as DraftMap;
}

function sameRef(left: AgentRuntimeConfigRef, right: AgentRuntimeConfigRef) {
  return left.key === right.key && left.version === right.version;
}

function normalizedAlias(value: string | null) {
  return String(value ?? "").trim() || null;
}

function isDraftDirty(config: AgentRoleRuntimeConfig, draft?: AgentRoleDraft) {
  if (!draft) return false;
  return !sameRef(config.promptRef, draft.promptRef)
    || !sameRef(config.modelProfileRef, draft.modelProfileRef)
    || config.skillRefs.length !== draft.skillRefs.length
    || config.skillRefs.some((ref, index) => !draft.skillRefs[index] || !sameRef(ref, draft.skillRefs[index]))
    || config.modelAliasOverride !== normalizedAlias(draft.modelAliasOverride)
    || config.temperatureMilli !== draft.temperatureMilli
    || config.maxOutputTokens !== draft.maxOutputTokens
    || config.enabled !== draft.enabled;
}

function refValue(ref: AgentRuntimeConfigRef) {
  return `${encodeURIComponent(ref.key)}@${encodeURIComponent(ref.version)}`;
}

function formatDate(value: number | null) {
  if (!value) return "尚未持久化";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTemperature(value: number | null) {
  return value === null ? "—" : (value / 1_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function profileLabel(profile: AgentRuntimeModelProfileRegistryItem) {
  return `${profile.key} · v${profile.version} · ${profile.modelAlias}`;
}

export default function AgentConfog({ onDirtyChange, onSavingChange }: AgentConfogProps) {
  const { toast } = useToast();
  const user = useAuthStore((state) => state.user);
  const workspace = useAuthStore((state) => state.currentWorkspace);
  const bootstrapped = useAuthStore((state) => state.bootstrapped);
  const canManage = isPlatformAdmin({ user, workspace });
  const [payload, setPayload] = useState<AgentRoleConfigListResult | null>(null);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [selectedRole, setSelectedRole] = useState<AgentRuntimeRole>("main");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflictNotice, setConflictNotice] = useState("");
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpCode, setStepUpCode] = useState("");
  const [stepUpError, setStepUpError] = useState("");
  const stepUpPasswordRef = useRef<HTMLInputElement>(null);

  const configMap = useMemo(() => new Map(payload?.configs.map((config) => [config.role, config]) ?? []), [payload]);
  const activeConfig = configMap.get(selectedRole);
  const draft = drafts[selectedRole];
  const activeDirty = Boolean(activeConfig && isDraftDirty(activeConfig, draft));
  const anyDirty = Boolean(payload?.configs.some((config) => isDraftDirty(config, drafts[config.role])));

  const prompts = useMemo(
    () => payload?.registry.prompts.filter((item) => item.role === selectedRole) ?? [],
    [payload, selectedRole],
  );
  const skills = useMemo(
    () => payload?.registry.skills.filter((item) => item.roles.includes(selectedRole)) ?? [],
    [payload, selectedRole],
  );
  const profiles = payload?.registry.modelProfiles ?? [];
  const selectedProfile = profiles.find((item) => draft && sameRef(item, draft.modelProfileRef));
  const resolvedModelAlias = normalizedAlias(draft?.modelAliasOverride ?? null)
    ?? selectedProfile?.modelAlias
    ?? activeConfig?.resolvedModelAlias
    ?? "—";
  const temperatureValid = Boolean(
    draft
      && draft.temperatureMilli !== null
      && Number.isSafeInteger(draft.temperatureMilli)
      && draft.temperatureMilli >= 0
      && draft.temperatureMilli <= 2_000,
  );
  const maxOutputTokensValid = Boolean(
    draft
      && draft.maxOutputTokens !== null
      && Number.isSafeInteger(draft.maxOutputTokens)
      && draft.maxOutputTokens >= 1
      && draft.maxOutputTokens <= 262_144,
  );

  const validation = {
    prompt: !draft || !prompts.some((item) => sameRef(item, draft.promptRef)) ? "请选择适用于当前角色的 Prompt 版本。" : undefined,
    profile: !draft || !profiles.some((item) => sameRef(item, draft.modelProfileRef)) ? "请选择有效的模型 Profile。" : undefined,
    alias: (draft?.modelAliasOverride.length ?? 0) > 200 ? "模型别名不能超过 200 个字符。" : undefined,
    temperature: temperatureValid ? undefined : "温度千分值需为 0–2000 的整数。",
    tokens: maxOutputTokensValid ? undefined : "最大输出需为 1–262144 的整数。",
  };
  const formInvalid = Object.values(validation).some(Boolean);

  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange?.(saving);
  }, [onSavingChange, saving]);

  useEffect(() => () => {
    onDirtyChange?.(false);
    onSavingChange?.(false);
  }, [onDirtyChange, onSavingChange]);

  useEffect(() => {
    if (!bootstrapped || !canManage) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void getAgentRoleConfigs(controller.signal)
      .then((next) => {
        setPayload(next);
        setDrafts(draftMapFromConfigs(next.configs));
        if (!next.registry.roles.includes(selectedRole)) setSelectedRole(next.registry.roles[0] ?? "main");
      })
      .catch((caught) => {
        if ((caught as { name?: string })?.name !== "AbortError") {
          setLoadError(caught instanceof Error ? caught.message : "Agent 角色配置加载失败。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [bootstrapped, canManage]);

  function updateDraft(updater: (current: AgentRoleDraft) => AgentRoleDraft) {
    setDrafts((current) => {
      const roleDraft = current[selectedRole];
      if (!roleDraft) return current;
      return { ...current, [selectedRole]: updater(roleDraft) };
    });
    setSaveError("");
  }

  async function reload(mode: "manual" | "conflict" = "manual", confirmed = false) {
    if (mode === "manual" && anyDirty && !confirmed) {
      setRefreshConfirmOpen(true);
      return;
    }
    setLoading(true);
    setLoadError("");
    setSaveError("");
    if (mode === "manual") setConflictNotice("");
    try {
      const next = await getAgentRoleConfigs();
      const nextDrafts = draftMapFromConfigs(next.configs);
      if (mode === "conflict" && payload) {
        for (const config of payload.configs) {
          if (config.role !== selectedRole && isDraftDirty(config, drafts[config.role])) {
            nextDrafts[config.role] = drafts[config.role];
          }
        }
      }
      setPayload(next);
      setDrafts(nextDrafts);
      if (!next.registry.roles.includes(selectedRole)) setSelectedRole(next.registry.roles[0] ?? "main");
      if (mode === "conflict") {
        setConflictNotice(`${ROLE_COPY[selectedRole].label}角色配置已被其他管理员更新，已刷新到最新版本；请重新确认后保存。`);
      } else {
        toast({ title: "已刷新为服务端最新配置", tone: "success" });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Agent 角色配置加载失败。";
      if (mode === "conflict") setSaveError(`检测到版本冲突，但刷新失败：${message}`);
      else setLoadError(message);
    } finally {
      setLoading(false);
    }
  }

  function selectProfile(value: string) {
    const profile = profiles.find((item) => refValue(item) === value);
    if (!profile) return;
    updateDraft((current) => ({
      ...current,
      modelProfileRef: cloneRef(profile),
      temperatureMilli: profile.temperatureMilli,
      maxOutputTokens: profile.maxOutputTokens,
    }));
  }

  function toggleSkill(ref: AgentRuntimeConfigRef, checked: boolean) {
    updateDraft((current) => {
      const withoutRef = current.skillRefs.filter((item) => !sameRef(item, ref));
      const selectedRefs = checked ? [...withoutRef, cloneRef(ref)] : withoutRef;
      const order = new Map(skills.map((item, index) => [refValue(item), index]));
      selectedRefs.sort((left, right) => (order.get(refValue(left)) ?? 999) - (order.get(refValue(right)) ?? 999));
      return { ...current, skillRefs: selectedRefs };
    });
  }

  function requestSave() {
    if (!draft || formInvalid || !activeDirty) return;
    setStepUpPassword("");
    setStepUpCode("");
    setStepUpError("");
    setStepUpOpen(true);
  }

  function closeStepUp() {
    setStepUpOpen(false);
    setStepUpPassword("");
    setStepUpCode("");
    setStepUpError("");
  }

  async function saveCurrentRole(stepUpProof: string) {
    if (!draft || formInvalid || !activeDirty) return true;
    setSaveError("");
    setConflictNotice("");
    try {
      const result = await updateAgentRoleConfig(selectedRole, {
        promptRef: cloneRef(draft.promptRef),
        skillRefs: draft.skillRefs.map(cloneRef),
        modelProfileRef: cloneRef(draft.modelProfileRef),
        modelAliasOverride: normalizedAlias(draft.modelAliasOverride),
        temperatureMilli: draft.temperatureMilli!,
        maxOutputTokens: draft.maxOutputTokens!,
        enabled: draft.enabled,
        expectedRevision: draft.revision,
      }, stepUpProof);
      setPayload((current) => current ? {
        ...current,
        configs: current.configs.map((config) => config.role === result.config.role ? result.config : config),
      } : current);
      setDrafts((current) => ({ ...current, [result.config.role]: draftFromConfig(result.config) }));
      toast({ title: "Agent 角色配置已保存", message: `${ROLE_COPY[selectedRole].label}角色修订版 ${result.config.revision}，后续新 Run 将使用该版本。`, tone: "success" });
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await reload("conflict");
        return true;
      }
      if (caught instanceof ApiError && caught.code?.startsWith("STEP_UP_")) {
        setStepUpError(caught.message);
        return false;
      } else {
        const message = caught instanceof Error ? caught.message : "Agent 角色配置保存失败。";
        setSaveError(message);
        return true;
      }
    }
  }

  async function verifyAndSave() {
    if (!stepUpPassword || saving) return;
    setSaving(true);
    setStepUpError("");
    try {
      const verification = await issueAgentRoleConfigStepUp({
        password: stepUpPassword,
        code: stepUpCode,
      });
      const shouldClose = await saveCurrentRole(verification.proof);
      if (shouldClose) {
        closeStepUp();
      }
    } catch (caught) {
      setStepUpError(caught instanceof Error ? caught.message : "管理员身份验证失败。");
    } finally {
      setSaving(false);
    }
  }

  if (!bootstrapped) {
    return (
      <div className="agentConfigSkeletons" role="status" aria-label="正在确认 Agent 配置权限">
        <Skeleton height="4.5rem" />
        <Skeleton height="14rem" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <section className="agentConfigAccess" aria-labelledby="agent-config-access-heading">
        <span className="agentConfigAccessIcon"><LockKeyhole size={22} aria-hidden="true" /></span>
        <div>
          <h3 id="agent-config-access-heading">需要平台管理员权限</h3>
          <p>角色运行配置会影响平台后续创建的 Agent Run，因此只允许平台管理员读取和修改；服务端仍会再次校验权限。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="agentConfig" aria-labelledby="agent-config-heading">
      <div className="agentConfigToolbar">
        <div>
          <h3 id="agent-config-heading">角色版本与运行参数</h3>
          <p>每次保存都会增加修订号；已创建的 Run 继续使用创建时固定的配置快照。</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCcw size={16} aria-hidden="true" />}
          loading={loading}
          disabled={saving}
          onClick={() => void reload()}
        >
          刷新
        </Button>
      </div>

      <div className="agentConfigSafetyNotice">
        <ShieldCheck size={19} aria-hidden="true" />
        <div>
          <strong>安全元数据视图</strong>
          <span>这里只展示 Prompt、Skill、Profile 的键与版本，不展示 Prompt/Skill 正文、供应商配置或任何凭据。</span>
        </div>
      </div>

      {payload && !payload.runtime.available ? (
        <Alert tone="danger" title="前台 Agent 当前不可用">
          角色开关只控制角色是否允许参与新 Run，不会开启运行服务。当前未就绪项：{
            (Object.entries(payload.runtime.switches) as Array<[keyof typeof RUNTIME_SWITCH_COPY, { enabled: boolean }]>)
              .filter(([, state]) => !state.enabled)
              .map(([key]) => RUNTIME_SWITCH_COPY[key])
              .join("、") || "运行服务"
          }。请在部署环境完成开关配置并通过就绪检查后再安排员工复测。
        </Alert>
      ) : payload && !payload.runtime.generationSubmit.enabled ? (
        <Alert tone="warning" title="Agent 对话可用，真实生成仍关闭">
          Runtime、Worker、模型和工具调用已就绪，但图片/视频真实提交开关尚未启用；生成类工具会拒绝产生供应商调用和扣费。
        </Alert>
      ) : payload ? (
        <Alert tone="success" title="前台 Agent 运行链路已启用">
          Runtime、Worker、模型、工具调用和真实生成提交均已开启；角色状态仍按下方各角色配置生效。
        </Alert>
      ) : null}

      {loadError ? (
        <Alert className="agentConfigLoadAlert" tone="danger" title="配置加载失败">
          <span>{loadError}</span>
          <Button variant="secondary" size="compact" onClick={() => void reload()}>重试</Button>
        </Alert>
      ) : null}

      {!payload && loading ? (
        <div className="agentConfigSkeletons" role="status" aria-label="正在加载 Agent 角色配置">
          <Skeleton height="3rem" />
          <Skeleton height="10rem" />
          <Skeleton height="10rem" />
        </div>
      ) : null}

      {payload && draft && activeConfig ? (
        <>
          <Tabs
            ariaLabel="Agent 角色"
            value={selectedRole}
            onValueChange={(role) => setSelectedRole(role as AgentRuntimeRole)}
            items={payload.registry.roles.map((role) => ({
              value: role,
              panelId: `agent-role-panel-${role}`,
              label: (
                <span className="agentConfigTabLabel">
                  {ROLE_COPY[role].label}
                  {isDraftDirty(configMap.get(role)!, drafts[role]) ? (
                    <>
                      <span className="agentConfigTabDirtyDot" aria-hidden="true" />
                      <span className="consoleSrOnly">有未保存修改</span>
                    </>
                  ) : null}
                </span>
              ),
            }))}
          />

          <div
            id={`agent-role-panel-${selectedRole}`}
            role="tabpanel"
            aria-label={`${ROLE_COPY[selectedRole].label} Agent 配置`}
            className="agentConfigRolePanel"
          >
            <header className="agentConfigRoleHeader">
              <span className="agentConfigRoleIcon"><Bot size={21} aria-hidden="true" /></span>
              <div className="agentConfigRoleCopy">
                <div>
                  <strong>{ROLE_COPY[selectedRole].label} Agent</strong>
                  <Badge tone={draft.enabled ? "success" : "neutral"}>{draft.enabled ? "已启用" : "已停用"}</Badge>
                  <Badge tone={activeConfig.source === "database" ? "info" : "neutral"}>
                    {activeConfig.source === "database" ? "数据库配置" : "Registry 默认"}
                  </Badge>
                  <Badge tone="neutral">修订版 {activeConfig.revision}</Badge>
                </div>
                <p>{ROLE_COPY[selectedRole].description}</p>
              </div>
              <div className="agentConfigResolvedModel">
                <span>解析后模型</span>
                <code>{resolvedModelAlias}</code>
              </div>
            </header>

            {conflictNotice ? (
              <Alert tone="warning" title="检测到修订冲突" role="alert">{conflictNotice}</Alert>
            ) : null}
            {saveError ? <Alert tone="danger" title="角色配置保存失败">{saveError}</Alert> : null}

            <form onSubmit={(event) => { event.preventDefault(); requestSave(); }}>
              <div className="agentConfigSections">
                <section className="agentConfigSection" aria-labelledby={`agent-config-refs-${selectedRole}`}>
                  <div className="agentConfigSectionHeading">
                    <div>
                      <h4 id={`agent-config-refs-${selectedRole}`}>版本引用</h4>
                      <p>选择 Registry 中已登记且适用于该角色的版本。</p>
                    </div>
                    <Database size={18} aria-hidden="true" />
                  </div>

                  <FormField label="Prompt 版本" required error={validation.prompt} optionalLabel={null}>
                    <Select
                      value={refValue(draft.promptRef)}
                      onChange={(event) => {
                        const prompt = prompts.find((item) => refValue(item) === event.currentTarget.value);
                        if (prompt) updateDraft((current) => ({ ...current, promptRef: cloneRef(prompt) }));
                      }}
                    >
                      {prompts.map((item) => <option key={refValue(item)} value={refValue(item)}>{item.key} · {item.version}</option>)}
                    </Select>
                  </FormField>

                  <FormField
                    label="模型 Profile"
                    required
                    error={validation.profile}
                    optionalLabel={null}
                    help="切换 Profile 会同步套用其温度和最大输出默认值，之后仍可调整。"
                  >
                    <Select value={refValue(draft.modelProfileRef)} onChange={(event) => selectProfile(event.currentTarget.value)}>
                      {profiles.map((profile) => <option key={refValue(profile)} value={refValue(profile)}>{profileLabel(profile)}</option>)}
                    </Select>
                  </FormField>

                  <fieldset className="agentConfigSkillFieldset">
                    <legend>Skill 版本</legend>
                    <p>只保存引用，不在管理界面返回或显示 Skill 正文。</p>
                    <div className="agentConfigSkillList">
                      {skills.map((skill) => {
                        const checked = draft.skillRefs.some((ref) => sameRef(ref, skill));
                        return (
                          <label key={refValue(skill)} className="agentConfigSkillOption">
                            <Checkbox
                              size="compact"
                              checked={checked}
                              onCheckedChange={(nextChecked) => toggleSkill(skill, nextChecked)}
                            />
                            <span><strong>{skill.displayName}</strong><code>{skill.key} · {skill.version}</code></span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </section>

                <section className="agentConfigSection" aria-labelledby={`agent-config-runtime-${selectedRole}`}>
                  <div className="agentConfigSectionHeading">
                    <div>
                      <h4 id={`agent-config-runtime-${selectedRole}`}>运行参数</h4>
                      <p>覆盖 Profile 默认值，并固定到后续新 Run 的快照。</p>
                    </div>
                    {selectedProfile ? (
                      <Button
                        variant="ghost"
                        size="compact"
                        icon={<RotateCcw size={15} aria-hidden="true" />}
                        onClick={() => updateDraft((current) => ({
                          ...current,
                          temperatureMilli: selectedProfile.temperatureMilli,
                          maxOutputTokens: selectedProfile.maxOutputTokens,
                        }))}
                      >
                        Profile 默认
                      </Button>
                    ) : null}
                  </div>

                  <FormField
                    label="模型别名覆盖"
                    help={`留空时使用 Profile 模型 ${selectedProfile?.modelAlias ?? activeConfig.resolvedModelAlias}。不在此处配置供应商地址或凭据。`}
                    error={validation.alias}
                  >
                    <Input
                      value={draft.modelAliasOverride}
                      maxLength={200}
                      placeholder="留空以继承 Profile"
                      autoComplete="off"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        updateDraft((current) => ({ ...current, modelAliasOverride: value }));
                      }}
                    />
                  </FormField>

                  <div className="agentConfigParameterGrid">
                    <FormField
                      label="温度（千分值）"
                      required
                      optionalLabel={null}
                      help={`当前等于 ${formatTemperature(draft.temperatureMilli)}`}
                      error={validation.temperature}
                    >
                      <NumberInput
                        value={draft.temperatureMilli}
                        min={0}
                        max={2_000}
                        step={50}
                        onValueChange={(value) => updateDraft((current) => ({ ...current, temperatureMilli: value }))}
                      />
                    </FormField>
                    <FormField
                      label="最大输出 Tokens"
                      required
                      optionalLabel={null}
                      help="允许范围 1–262144"
                      error={validation.tokens}
                    >
                      <NumberInput
                        value={draft.maxOutputTokens}
                        min={1}
                        max={262_144}
                        step={1}
                        onValueChange={(value) => updateDraft((current) => ({ ...current, maxOutputTokens: value }))}
                      />
                    </FormField>
                  </div>

                  {selectedProfile ? (
                    <div className="agentConfigProfileMeta" aria-label="当前 Profile 元数据">
                      <div><span>Profile</span><code>{selectedProfile.key} · {selectedProfile.version}</code></div>
                      <div><span>默认模型</span><code>{selectedProfile.modelAlias}</code></div>
                      <div><span>能力标签</span><div>{selectedProfile.capabilities.map((item) => <Badge key={item} tone="neutral">{item}</Badge>)}</div></div>
                    </div>
                  ) : null}
                </section>

                <section className="agentConfigSection agentConfigStatusSection" aria-labelledby={`agent-config-status-${selectedRole}`}>
                  <div>
                    <h4 id={`agent-config-status-${selectedRole}`}>角色状态与审计信息</h4>
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(checked) => updateDraft((current) => ({ ...current, enabled: checked }))}
                      label={draft.enabled ? "允许后续新 Run 使用该角色" : "暂停后续新 Run 使用该角色"}
                      description="停用只影响后续调度，不会改写已创建 Run 的固定快照。"
                    />
                  </div>
                  <dl>
                    <div><dt>当前来源</dt><dd>{activeConfig.source === "database" ? "数据库持久化" : "Registry 默认值"}</dd></div>
                    <div><dt>最后更新</dt><dd>{formatDate(activeConfig.updatedAt)}</dd></div>
                    <div><dt>更新用户</dt><dd>{activeConfig.updatedBy === null ? "—" : `用户 #${activeConfig.updatedBy}`}</dd></div>
                  </dl>
                </section>
              </div>

              <div className="agentConfigActions agentConfigActions--sticky">
                <span role="status">
                  {activeDirty ? `有未保存修改，将基于修订版 ${draft.revision} 提交` : "当前角色没有未保存修改"}
                </span>
                <Button
                  type="submit"
                  icon={<Save size={16} aria-hidden="true" />}
                  loading={saving}
                  disabled={!activeDirty || formInvalid || loading}
                >
                  保存{ROLE_COPY[selectedRole].label}配置
                </Button>
              </div>
            </form>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={refreshConfirmOpen}
        title="放弃未保存的角色配置？"
        description="刷新会丢弃全部角色尚未保存的修改，并重新读取服务端最新配置。"
        confirmLabel="放弃并刷新"
        tone="danger"
        onCancel={() => setRefreshConfirmOpen(false)}
        onConfirm={() => reload("manual", true)}
      />

      <Dialog
        open={stepUpOpen}
        title="验证管理员身份"
        description={`保存${ROLE_COPY[selectedRole].label}角色配置前，需要完成一次敏感操作验证。验证凭证仅用于本次保存。`}
        size="sm"
        loading={saving}
        initialFocusRef={stepUpPasswordRef}
        onOpenChange={(open) => {
          if (!open && !saving) {
            closeStepUp();
          }
        }}
        footer={(
          <div className="agentConfigStepUpActions">
            <Button variant="secondary" disabled={saving} onClick={closeStepUp}>取消</Button>
            <Button
              icon={<KeyRound size={16} aria-hidden="true" />}
              loading={saving}
              disabled={!stepUpPassword}
              onClick={() => void verifyAndSave()}
            >
              验证并保存
            </Button>
          </div>
        )}
      >
        <form className="agentConfigStepUpForm" onSubmit={(event) => { event.preventDefault(); void verifyAndSave(); }}>
          <div className="agentConfigStepUpNotice">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>密码和验证码只发送到身份验证接口，不会写入 Agent 配置或审计元数据。</span>
          </div>
          {stepUpError ? <Alert tone="danger" title="管理员身份验证失败">{stepUpError}</Alert> : null}
          <FormField label="当前密码" required optionalLabel={null}>
            <Input
              ref={stepUpPasswordRef}
              type="password"
              value={stepUpPassword}
              autoComplete="current-password"
              onChange={(event) => setStepUpPassword(event.currentTarget.value)}
            />
          </FormField>
          <FormField label="MFA / 恢复码" help="账号已启用 MFA 时必填；可输入动态验证码或一次性恢复码。">
            <Input
              value={stepUpCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              onChange={(event) => setStepUpCode(event.currentTarget.value)}
            />
          </FormField>
        </form>
      </Dialog>
    </section>
  );
}
