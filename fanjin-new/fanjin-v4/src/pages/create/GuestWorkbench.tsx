import { lazy, Suspense, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  Images,
  Mic,
  Plus,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import FrontstageNav from "../frontstage/FrontstageNav";
import { useV4Theme } from "../../ui/useV4Theme";
import {
  readGuestDraft,
  saveGuestDraft,
  type GuestDraft,
} from "../../features/auth/guestDraft";
import workbenchReference from "../../assets/public-placeholder.svg";
import futureCityPreview from "../../assets/public-placeholder.svg";
import jimengLogo from "../../assets/public-placeholder.svg";
import doubaoLogo from "../../assets/public-placeholder.svg";
import InspirationShowcase from "../../features/showcase/InspirationShowcase";
import { appendCreativeBrief } from "../../features/showcase/catalog";
import "./QuickCreateView.css";
import "./GuestWorkbench.css";

const LoginPage = lazy(() => import("../login/LoginPage"));
const cards = [
  {
    title: "流程视图",
    description: "六阶段创作流程",
    image: workbenchReference,
    badge: "Beta",
    path: "/workbench/quick-create",
  },
  {
    title: "画布模式",
    description: "自由创作",
    image: futureCityPreview,
    path: "/workbench/canvas",
  },
  {
    title: "图片生成",
    description: "智能美学提升",
    image: jimengLogo,
    badge: "New",
  },
  {
    title: "视频生成",
    description: "火山视频模型",
    image: doubaoLogo,
    badge: "New",
  },
];

/** Public shell. The authenticated creator and its private data hooks are never mounted here. */
export default function GuestWorkbench({
  initialLoginOpen = false,
}: {
  initialLoginOpen?: boolean;
}) {
  const theme = useV4Theme();
  const [params] = useSearchParams();
  const initial = useRef(readGuestDraft());
  const [brief, setBrief] = useState(
    initial.current?.owner ? "" : initial.current?.brief || "",
  );
  const [mode, setMode] = useState<GuestDraft["mode"]>(
    initial.current?.owner ? "视频生成" : initial.current?.mode || "视频生成",
  );
  const [modeOpen, setModeOpen] = useState(false);
  const loginTrigger = useRef<HTMLElement | null>(null);
  const [loginOpen, setLoginOpen] = useState(initialLoginOpen);
  const [loginMounted, setLoginMounted] = useState(initialLoginOpen);
  const [destination, setDestination] = useState(
    params.get("redirect") || "/workbench/create",
  );

  function updateDraft(nextBrief: string, nextMode = mode) {
    setBrief(nextBrief);
    setMode(nextMode);
    const source = readGuestDraft();
    saveGuestDraft({ brief: nextBrief, mode: nextMode, ...(source?.sourceCaseId ? {sourceCaseId: source.sourceCaseId, sourceIdea: source.sourceIdea} : {}) });
  }
  function openLogin(path = "/workbench/create") {
    // Capture before the guest shell becomes inert and loses activeElement.
    loginTrigger.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const source = readGuestDraft();
    saveGuestDraft({ brief, mode, ...(source?.sourceCaseId ? {sourceCaseId: source.sourceCaseId, sourceIdea: source.sourceIdea} : {}) });
    setDestination(path);
    setModeOpen(false);
    setLoginMounted(true);
    setLoginOpen(true);
  }
  function closeLogin() {
    setLoginOpen(false);
    requestAnimationFrame(() => {
      if (loginTrigger.current?.isConnected) {
        loginTrigger.current.focus({ preventScroll: true });
      }
    });
  }
  return (
    <main
      className={`jimengWorkbench jimengCreateWorkbench guestWorkbench ${theme.mode === "dark" ? "themeDark" : "themeLight"}`}
      data-testid="guest-workbench"
    >
      <section className="jimengShell" inert={loginOpen}>
        <FrontstageNav
          active="inspiration"
          guest
          onLogin={openLogin}
          dark={theme.mode === "dark"}
          onToggleDark={theme.toggle}
        />
        <div className="jimengMainPane" onClick={() => setModeOpen(false)}>
          <section className="jimengHero">
            <p>AI VIDEO CREATION COMMAND CENTER</p>
            <h1>
              让想象抵达画面，从{" "}
              <button
                type="button"
                className="jimengTitleMode"
                aria-expanded={modeOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setModeOpen(!modeOpen);
                }}
              >
                {mode}
                <ChevronRight className="jimengTitleChevron" size={22} />
              </button>{" "}
              开始
            </h1>
          </section>
          <div className="jimengCreatorStage">
            <section className="jimengComposerPanel">
              <div className="jimengComposerTop">
                <button
                  className="jimengUploadTile"
                  type="button"
                  aria-label="上传参考"
                  onClick={() => openLogin()}
                >
                  <Plus size={24} />
                  <span className="jimengUploadLabel">
                    上传
                    <br />
                    参考
                  </span>
                </button>
                <textarea
                  aria-label="创作想法"
                  value={brief}
                  maxLength={20_000}
                  onChange={(event) => updateDraft(event.target.value)}
                  placeholder="输入想法、剧本或上传参考，让灵感成为画面"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      openLogin();
                    }
                  }}
                />
              </div>
              <div className="jimengComposerControls">
                <div className="jimengCommandGroup">
                  <button
                    className="jimengCommandButton"
                    type="button"
                    aria-expanded={modeOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setModeOpen(!modeOpen);
                    }}
                  >
                    <WandSparkles size={16} />
                    {mode}
                    <ChevronDown size={14} />
                  </button>
                  <button
                    className="jimengCommandButton"
                    type="button"
                    onClick={() => openLogin()}
                  >
                    <Bot size={16} />
                    选择模型
                    <ChevronDown size={14} />
                  </button>
                  {mode === "视频生成" && (
                    <button
                      className="jimengCommandButton"
                      type="button"
                      onClick={() => openLogin()}
                    >
                      <Images size={16} />
                      参考模式
                      <ChevronDown size={14} />
                    </button>
                  )}
                  <button
                    className="jimengCommandButton"
                    type="button"
                    onClick={() => openLogin()}
                  >
                    <SlidersHorizontal size={16} />
                    生成设置
                  </button>
                  {mode === "视频生成" && (
                    <button
                      className="jimengCommandButton"
                      type="button"
                      onClick={() => openLogin()}
                    >
                      <Clock3 size={16} />
                      时长
                    </button>
                  )}
                  <button
                    className="jimengCommandButton"
                    type="button"
                    onClick={() => openLogin()}
                  >
                    <WandSparkles size={16} />
                    使用技能
                  </button>
                  <button
                    className="jimengCommandButton"
                    type="button"
                    onClick={() => openLogin()}
                  >
                    <AtSign size={16} />
                    资产库
                  </button>
                </div>
                <div className="jimengSendGroup">
                  <button
                    className="jimengIconButton composerIcon"
                    type="button"
                    aria-label="语音输入"
                    onClick={() => openLogin()}
                  >
                    <Mic size={18} />
                  </button>
                  <button
                    className="jimengSendButton"
                    type="button"
                    aria-label="开始创作"
                    onClick={() => openLogin()}
                  >
                    <ArrowUp size={20} />
                  </button>
                </div>
              </div>
              {modeOpen && (
                <div
                  className="guestModeMenu"
                  role="group"
                  aria-label="创作类型"
                >
                  {(["视频生成", "图片生成", "创意导演", "Agent 模式"] as const).map(
                    (value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={mode === value}
                        onClick={() => {
                          updateDraft(brief, value);
                          setModeOpen(false);
                        }}
                      >
                        {value}
                      </button>
                    ),
                  )}
                </div>
              )}
            </section>
            <section className="jimengModeStrip" aria-label="创作入口">
              {cards.map((card) => (
                <button
                  key={card.title}
                  className={mode === card.title ? "active" : ""}
                  type="button"
                  onClick={() => {
                    if (card.path) openLogin(card.path);
                    else updateDraft(brief, card.title as GuestDraft["mode"]);
                  }}
                >
                  <img className="jimengModeThumb" src={card.image} alt="" />
                  <span>
                    <strong>{card.title}</strong>
                    <small>{card.description}</small>
                  </span>
                  {card.badge && <em>{card.badge}</em>}
                </button>
              ))}
            </section>
          </div>
          <InspirationShowcase dark={theme.mode === "dark"} guest hasDraft={Boolean(brief.trim())} onUseSource={async (item, idea) => {
            saveGuestDraft({brief, mode: "视频生成", sourceCaseId: item.id, sourceIdea: idea});
            // Login belongs to the existing auth flow; no assets or generation run while logged out.
            requestAnimationFrame(() => { setDestination("/workbench/create"); setLoginMounted(true); setLoginOpen(true); });
          }} onUseBrief={(incoming) => {
            updateDraft(appendCreativeBrief(brief, incoming), "Agent 模式");
            const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="创作想法"]');
            composer?.focus({ preventScroll: true });
            composer?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          }} />
        </div>
      </section>
      {loginMounted && (
        <Suspense
          fallback={
            <div className="guestLoginLoading" role="status">
              正在打开登录…
            </div>
          }
        >
          <LoginPage
            open={loginOpen}
            onClose={closeLogin}
            redirectTo={destination}
          />
        </Suspense>
      )}
    </main>
  );
}
