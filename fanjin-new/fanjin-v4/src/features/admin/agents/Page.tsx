import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  ConsolePage,
  DataTable,
  EmptyState,
  Section,
  Skeleton,
} from "../../../ui/console";
import {
  fetchAgentConfigRoles,
  fetchAgentModelProfiles,
  fetchAgentSkills,
} from "./api";
import type {
  AgentModelProfileRecord,
  AgentRoleConfigRecord,
  AgentSkillRecord,
} from "./types";

const ROLE_LABELS: Record<string, string> = {
  main: "主 Agent",
  writer: "编剧 Agent",
  visual: "视觉 Agent",
  storyboard: "分镜 Agent",
  executor: "执行 Agent",
  reviewer: "复核 Agent",
};

const STATUS_TONE = (enabled: boolean) => (enabled ? "success" as const : "neutral" as const);
const STATUS_LABEL = (enabled: boolean) => (enabled ? "已启用" : "已禁用");

function roleColumns() {
  return [
    { id: "role", header: "角色", priority: "primary" as const, cell: (row: AgentRoleConfigRecord) => ROLE_LABELS[row.role] ?? row.role },
    { id: "enabled", header: "状态", cell: (row: AgentRoleConfigRecord) => <Badge tone={STATUS_TONE(row.enabled)}>{STATUS_LABEL(row.enabled)}</Badge> },
    { id: "modelAlias", header: "模型", cell: (row: AgentRoleConfigRecord) => <code>{row.resolvedModelAlias}{row.modelAliasOverride ? <> &rarr; {row.modelAliasOverride}</> : null}</code> },
    { id: "skills", header: "技能数", align: "end" as const, cell: (row: AgentRoleConfigRecord) => String(row.skillRefs.length) },
    { id: "source", header: "配置源", cell: (row: AgentRoleConfigRecord) => <Badge tone={row.source === "registry" ? "neutral" as const : "info" as const}>{row.source === "registry" ? "注册表" : "数据库"}</Badge> },
    { id: "revision", header: "版本", align: "end" as const, cell: (row: AgentRoleConfigRecord) => String(row.revision) },
  ];
}

function skillColumns() {
  return [
    { id: "key", header: "技能标识", priority: "primary" as const, cell: (row: AgentSkillRecord) => <code>{row.key}</code> },
    { id: "displayName", header: "名称", cell: (row: AgentSkillRecord) => row.displayName },
    { id: "version", header: "版本", cell: (row: AgentSkillRecord) => <code>{row.version}</code> },
    { id: "roles", header: "适用角色", cell: (row: AgentSkillRecord) => row.roles.map((role) => <Badge key={role} tone="neutral">{ROLE_LABELS[role] ?? role}</Badge>) },
  ];
}

function modelProfileColumns() {
  return [
    { id: "key", header: "Profile", priority: "primary" as const, cell: (row: AgentModelProfileRecord) => <code>{row.key}</code> },
    { id: "modelAlias", header: "模型别名", cell: (row: AgentModelProfileRecord) => <code>{row.modelAlias}</code> },
    { id: "version", header: "版本", cell: (row: AgentModelProfileRecord) => <code>{row.version}</code> },
    { id: "temperature", header: "温度", align: "end" as const, cell: (row: AgentModelProfileRecord) => (row.temperatureMilli / 1000).toFixed(2) },
    { id: "maxTokens", header: "最大输出", align: "end" as const, cell: (row: AgentModelProfileRecord) => row.maxOutputTokens.toLocaleString() },
    { id: "capabilities", header: "Canonical capabilities", cell: (row: AgentModelProfileRecord) => row.capabilities.map((capability) => <Badge key={capability} tone="neutral">{capability}</Badge>) },
  ];
}

type SectionState<Row> = {
  rows: Row[];
  loading: boolean;
  error: string | null;
};

function initialSectionState<Row>(): SectionState<Row> {
  return { rows: [], loading: true, error: null };
}

function SectionBody<Row>({
  state,
  emptyTitle,
  emptyDescription,
  retry,
  children,
}: {
  state: SectionState<Row>;
  emptyTitle: string;
  emptyDescription: string;
  retry: () => void;
  children: ReactNode;
}) {
  if (state.loading) return <Skeleton height={180} />;
  if (state.error) {
    return (
      <EmptyState
        title="加载失败"
        description={state.error}
        action={<Button variant="secondary" onClick={retry}>重试</Button>}
      />
    );
  }
  if (state.rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <>{children}</>;
}

export default function AgentCenterPage() {
  const [roles, setRoles] = useState<SectionState<AgentRoleConfigRecord>>(initialSectionState);
  const [skills, setSkills] = useState<SectionState<AgentSkillRecord>>(initialSectionState);
  const [modelProfiles, setModelProfiles] = useState<SectionState<AgentModelProfileRecord>>(initialSectionState);
  const configRefresh = useRef(0);
  const skillsRefresh = useRef(0);

  const loadConfigSections = useCallback(() => {
    const refresh = ++configRefresh.current;
    setRoles((current) => ({ ...current, loading: true, error: null }));
    setModelProfiles((current) => ({ ...current, loading: true, error: null }));

    void Promise.allSettled([
      fetchAgentConfigRoles(),
      fetchAgentModelProfiles(),
    ]).then(([roleResult, modelResult]) => {
      if (refresh !== configRefresh.current) return;
      setRoles(roleResult.status === "fulfilled"
        ? { rows: roleResult.value, loading: false, error: null }
        : { rows: [], loading: false, error: "Agent 角色配置加载失败" });
      setModelProfiles(modelResult.status === "fulfilled"
        ? { rows: modelResult.value, loading: false, error: null }
        : { rows: [], loading: false, error: "模型 Profile 加载失败" });
    });
  }, []);

  const loadSkills = useCallback(() => {
    const refresh = ++skillsRefresh.current;
    setSkills((current) => ({ ...current, loading: true, error: null }));
    void fetchAgentSkills()
      .then((rows) => {
        if (refresh === skillsRefresh.current) {
          setSkills({ rows, loading: false, error: null });
        }
      })
      .catch(() => {
        if (refresh === skillsRefresh.current) {
          setSkills({ rows: [], loading: false, error: "技能目录加载失败" });
        }
      });
  }, []);

  useEffect(() => {
    loadConfigSections();
    loadSkills();
    return () => {
      configRefresh.current += 1;
      skillsRefresh.current += 1;
    };
  }, [loadConfigSections, loadSkills]);

  return (
    <ConsolePage
      breadcrumbs={[{ label: "AI 策略" }, { label: "Agent 中枢" }]}
      layoutWidth="content"
      title="Agent 中枢"
      description="查看全平台 Agent 角色、技能集与模型配置。"
    >
      <Section
        title="Agent 角色配置"
        description={`共 ${roles.rows.length} 个角色；数据来源：/agent/config/roles（管理员控制面）。`}
      >
        <SectionBody state={roles} emptyTitle="暂无数据" emptyDescription="未获取到角色配置" retry={loadConfigSections}>
          <DataTable<AgentRoleConfigRecord> columns={roleColumns()} rows={roles.rows} getRowId={(row) => row.role} />
        </SectionBody>
      </Section>

      <Section
        title="Agent 技能目录"
        description={`${skills.rows.length} 个可选公开技能。`}
      >
        <SectionBody state={skills} emptyTitle="暂无数据" emptyDescription="未获取到技能列表" retry={loadSkills}>
          <DataTable<AgentSkillRecord> columns={skillColumns()} rows={skills.rows} getRowId={(row) => `${row.key}:${row.version}`} />
        </SectionBody>
      </Section>

      <Section
        title="模型 Profile"
        description={`${modelProfiles.rows.length} 个 canonical runtime model profile。`}
      >
        <SectionBody state={modelProfiles} emptyTitle="暂无数据" emptyDescription="未获取到模型 Profile" retry={loadConfigSections}>
          <DataTable<AgentModelProfileRecord> columns={modelProfileColumns()} rows={modelProfiles.rows} getRowId={(row) => `${row.key}:${row.version}`} />
        </SectionBody>
      </Section>
    </ConsolePage>
  );
}
