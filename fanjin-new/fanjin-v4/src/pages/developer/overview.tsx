import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, Boxes, ClipboardList, CreditCard, FileClock, KeyRound, TerminalSquare } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { ConsolePage } from "../../ui/console";
import "./DeveloperConsole.css";
import { DeveloperCatalogProvider } from "./useDeveloperCatalog";

const TAB_CONFIG = [
  { id: "billing", label: "用量与账单", icon: CreditCard, path: "/developer" },
  { id: "keys", label: "API 中转密钥", icon: KeyRound, path: "/developer/api/keys" },
  { id: "docs", label: "文档", icon: BookOpen, path: "/developer/api/docs" },
  { id: "request", label: "调试", icon: TerminalSquare, path: "/developer/api/request" },
  { id: "tasks", label: "任务", icon: ClipboardList, path: "/developer/api/tasks" },
  { id: "logs", label: "日志", icon: FileClock, path: "/developer/api/logs" },
  { id: "models", label: "模型与能力", icon: Boxes, path: "/developer/api/models" },
] as const;

function resolveActiveTab(pathname: string): string {
  if (pathname.startsWith("/developer/api/keys")) return "keys";
  if (pathname.startsWith("/developer/api/docs")) return "docs";
  if (pathname.startsWith("/developer/api/request")) return "request";
  if (pathname.startsWith("/developer/api/tasks")) return "tasks";
  if (pathname.startsWith("/developer/api/logs")) return "logs";
  if (pathname.startsWith("/developer/api/models")) return "models";
  return "billing";
}

export default function DeveloperOverviewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState(() => resolveActiveTab(location.pathname));

  useEffect(() => {
    setActiveTab(resolveActiveTab(location.pathname));
  }, [location.pathname]);

  function handleTabChange(value: string) {
    const tab = TAB_CONFIG.find((t) => t.id === value);
    if (tab) {
      setActiveTab(value);
      navigate(tab.path);
    }
  }

  return (
    <DeveloperCatalogProvider>
      <ConsolePage
        eyebrow="Developer API"
        title="开发者总览"
        description="管理 API 密钥、调用文档、在线调试、任务、日志与当前工作区模型目录。"
        className="developerOverview"
        showHeader={false}
      >
        {/* 横向标签导航 */}
        <div className="developerTabBar">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="bg-transparent h-auto gap-1 p-0">
              {TAB_CONFIG.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-[var(--cui-text-muted)] data-[state=active]:bg-[var(--cui-surface-subtle)] data-[state=active]:text-[var(--cui-text)] data-[state=active]:shadow-sm rounded-md transition-colors"
                  >
                    <Icon size={14} />
                    <span>{tab.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        {/* 内容区域 */}
        <div className="developerTabContent" data-developer-content-viewport="stable">
          <Outlet />
        </div>
      </ConsolePage>
    </DeveloperCatalogProvider>
  );
}
