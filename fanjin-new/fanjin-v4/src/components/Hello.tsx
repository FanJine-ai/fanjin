import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

/* ── 内联样式 ─────────────────────────────────────────── */
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  width: 680,
  maxHeight: "90vh",
  overflow: "auto",
  boxShadow: "0 24px 48px rgba(0,0,0,0.18)",
};

const guideStyle: React.CSSProperties = {
  padding: "24px 16px",
};

const welcomePageStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "40px 0 24px",
  position: "relative",
};

const welcomeLogoStyle: React.CSSProperties = {
  width: 120,
  height: 120,
  objectFit: "contain",
  marginBottom: 24,
};

const welcomeTitleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  margin: "0 0 12px",
  color: "#18181b",
};

const welcomeDescStyle: React.CSSProperties = {
  color: "#71717a",
  fontSize: 15,
  margin: "0 0 32px",
  textAlign: "center" as const,
  lineHeight: 1.6,
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 28px",
  borderRadius: 8,
  border: 0,
  background: "#0052d9",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
};

const textBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: 0,
  background: "transparent",
  color: "#0052d9",
  fontSize: 13,
  cursor: "pointer",
};

const outlineBtn: React.CSSProperties = {
  padding: "8px 20px",
  borderRadius: 8,
  border: "1px solid #dcdcdc",
  background: "#fff",
  color: "#18181b",
  fontSize: 14,
  cursor: "pointer",
};

const stepsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  gap: 40,
  marginBottom: 32,
};

const stepItem = (active: boolean, done: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: active ? "#0052d9" : done ? "#00a870" : "#bbb",
  fontSize: 14,
  fontWeight: active ? 700 : 400,
});

const stepCircle = (active: boolean, done: boolean): React.CSSProperties => ({
  width: 24,
  height: 24,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  background: active ? "#0052d9" : done ? "#00a870" : "#e8e8e8",
  color: active || done ? "#fff" : "#999",
  fontSize: 12,
  fontWeight: 700,
});

const stepContentStyle: React.CSSProperties = {
  minHeight: 300,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const stepItemContainer: React.CSSProperties = {
  textAlign: "center" as const,
  maxWidth: 480,
};

const stepIconStyle: React.CSSProperties = {
  marginBottom: 16,
  color: "#0052d9",
  fontSize: 48,
};

const stepTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  margin: "0 0 12px",
  color: "#18181b",
};

const stepDescStyle: React.CSSProperties = {
  color: "#71717a",
  fontSize: 14,
  lineHeight: 1.8,
  margin: "0 0 20px",
};

const tipBoxStyle: React.CSSProperties = {
  marginBottom: 20,
  padding: "12px 16px",
  borderRadius: 8,
  background: "#e8f4ff",
  border: "1px solid #b3d8ff",
  color: "#0052d9",
  fontSize: 13,
  lineHeight: 1.6,
};

const qrcodeBoxStyle: React.CSSProperties = {
  marginTop: 16,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const qrcodeLabelStyle: React.CSSProperties = {
  color: "#71717a",
  fontSize: 13,
  marginBottom: 8,
};

const qrcodePlaceholderStyle: React.CSSProperties = {
  width: 160,
  height: 160,
  display: "grid",
  placeItems: "center",
  border: "2px dashed #dcdcdc",
  borderRadius: 8,
  color: "#999",
  fontSize: 12,
};

const githubBoxStyle: React.CSSProperties = {
  marginTop: 20,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginTop: 24,
  borderTop: "1px solid #e8e8e8",
  paddingTop: 16,
};

const footerRightStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginLeft: "auto",
};

const langBtnStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  right: 0,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #dcdcdc",
  background: "#fff",
  color: "#71717a",
  fontSize: 12,
  cursor: "pointer",
};

/* ── 常量 ─────────────────────────────────────────────── */
const STEP_LABELS = ["配置模型服务", "配置数据", "开始使用"];

/* ── 组件 ─────────────────────────────────────────────── */
interface HelloProps {
  visible?: boolean;
  onClose?: () => void;
  /** 可选：外部控制显示，如不传则组件内部管理 */
  defaultVisible?: boolean;
}

export default function Hello({ visible: controlledVisible, onClose, defaultVisible = false }: HelloProps) {
  const navigate = useNavigate();
  const [internalShow, setInternalShow] = useState(defaultVisible);
  const show = controlledVisible ?? internalShow;
  const [currentStep, setCurrentStep] = useState(0);
  const [langOpen, setLangOpen] = useState(false);

  const close = useCallback(() => {
    setInternalShow(false);
    localStorage.setItem("helloGuideDone", "true");
    onClose?.();
  }, [onClose]);

  function openVendorConfig() {
    close();
    navigate("/developer/api/models");
  }

  function openAgentConfig() {
    close();
    navigate("/developer/api/models");
  }

  function handleFinish() {
    close();
    // 简单纸屑效果：创建 DOM 动画
    try {
      const colors = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#ff6bd6"];
      const container = document.createElement("div");
      container.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden";
      document.body.appendChild(container);
      for (let i = 0; i < 60; i++) {
        const el = document.createElement("div");
        const size = Math.random() * 8 + 4;
        el.style.cssText = `
          position:absolute;
          width:${size}px;height:${size}px;
          background:${colors[i % colors.length]};
          border-radius:${Math.random() > 0.5 ? "50%" : "2px"};
          left:${Math.random() * 100}%;
          top:-10px;
          opacity:1;
          transition:all ${1 + Math.random() * 1.5}s ease-out;
        `;
        container.appendChild(el);
        requestAnimationFrame(() => {
          el.style.top = `${100 + Math.random() * 30}%`;
          el.style.opacity = "0";
          el.style.transform = `rotate(${Math.random() * 720}deg) translateX(${(Math.random() - 0.5) * 200}px)`;
        });
      }
      setTimeout(() => container.remove(), 3000);
    } catch {
      /* ignore */
    }
  }

  function enterDeveloper() {
    close();
    navigate("/developer/api/keys");
  }

  if (!show) return null;

  return (
    <div style={overlayStyle} onClick={close}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <div style={guideStyle}>
          {/* ── 欢迎首页 ── */}
          {currentStep === 0 && (
            <div style={welcomePageStyle}>
              <div style={welcomeLogoStyle}>
                <svg viewBox="0 0 120 120" width="120" height="120">
                  <defs>
                    <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#0a84ff" />
                      <stop offset="100%" stopColor="#007aff" />
                    </linearGradient>
                  </defs>
                  <rect x="10" y="10" width="100" height="100" rx="24" fill="url(#logoGrad)" />
                  <text x="60" y="78" textAnchor="middle" fill="#fff" fontSize="52" fontWeight="900" fontFamily="system-ui">
                    F
                  </text>
                </svg>
              </div>
              <h1 style={welcomeTitleStyle}>欢迎使用 Fanjin</h1>
              <p style={welcomeDescStyle}>
                让 AI 帮你高效管理创作流程，从剧本到成片一站式完成。
                <br />
                让我们完成基础配置，开启你的创作之旅。
              </p>
              <button style={primaryBtn} onClick={() => setCurrentStep(1)}>
                开始配置
              </button>
              <button
                style={{ ...textBtn, marginTop: 12 }}
                onClick={close}
              >
                跳过引导
              </button>
              <button style={langBtnStyle} onClick={() => setLangOpen(!langOpen)}>
                🌐 语言
              </button>
              {langOpen && (
                <div style={{ position: "absolute", bottom: 36, right: 0, background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", overflow: "hidden" }}>
                  {["简体中文", "English", "日本語"].map((lang) => (
                    <button
                      key={lang}
                      style={{ display: "block", width: "100%", padding: "8px 16px", border: 0, background: "transparent", color: "#18181b", fontSize: 13, cursor: "pointer", textAlign: "left" as const }}
                      onClick={() => setLangOpen(false)}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 配置步骤 ── */}
          {currentStep > 0 && (
            <>
              {/* 步骤条 */}
              <div style={stepsStyle}>
                {STEP_LABELS.map((label, i) => {
                  const stepIdx = i + 1;
                  const active = currentStep === stepIdx;
                  const done = currentStep > stepIdx;
                  return (
                    <div key={label} style={stepItem(active, done)}>
                      <span style={stepCircle(active, done)}>
                        {done ? "✓" : stepIdx}
                      </span>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>

              {/* 步骤内容 */}
              <div style={stepContentStyle}>
                {/* Step 1: 配置模型服务 */}
                {currentStep === 1 && (
                  <div style={stepItemContainer}>
                    <div style={stepIconStyle}>🖥️</div>
                    <h2 style={stepTitleStyle}>配置模型服务</h2>
                    <p style={stepDescStyle}>
                      选择并配置你的 AI 模型供应商。支持 OpenAI、Claude、通义千问等多种模型服务，
                      配置完成后即可使用智能创作功能。
                    </p>
                    <div style={tipBoxStyle}>
                      💡 提示：你可以在「供应商通道」中管理多个模型服务商，也可以稍后在设置中完成配置。
                    </div>
                    <button style={primaryBtn} onClick={openVendorConfig}>
                      ⚙️ 前往配置模型服务
                    </button>
                  </div>
                )}

                {/* Step 2: 配置 Agent */}
                {currentStep === 2 && (
                  <div style={stepItemContainer}>
                    <div style={stepIconStyle}>🤖</div>
                    <h2 style={stepTitleStyle}>配置创作助手</h2>
                    <p style={stepDescStyle}>
                      为你的创作工作流配置 AI Agent。你可以设置默认的模型、调整创作偏好，
                      让 AI 更好地理解你的需求。
                    </p>
                    <div style={tipBoxStyle}>
                      💡 提示：你也可以使用默认配置，稍后在「模型管理」中自定义调整。
                    </div>
                    <button style={primaryBtn} onClick={openAgentConfig}>
                      ⚙️ 前往配置创作助手
                    </button>
                  </div>
                )}

                {/* Step 3: 完成 */}
                {currentStep === 3 && (
                  <div style={stepItemContainer}>
                    <div style={{ ...stepIconStyle, color: "#00a870" }}>✅</div>
                    <h2 style={stepTitleStyle}>配置完成！</h2>
                    <p style={stepDescStyle}>
                      恭喜你完成了基础配置！现在可以开始使用 Fanjin 进行智能创作了。
                    </p>
                    <div style={qrcodeBoxStyle}>
                      <p style={qrcodeLabelStyle}>扫码加入用户社群</p>
                      <div style={qrcodePlaceholderStyle}>
                        <div style={{ textAlign: "center" as const }}>
                          <div style={{ fontSize: 32, marginBottom: 4 }}>📱</div>
                          <div>二维码区域</div>
                        </div>
                      </div>
                    </div>
                    <div style={githubBoxStyle}>
                      <p style={qrcodeLabelStyle}>API 控制台</p>
                      <button style={primaryBtn} onClick={enterDeveloper}>
                        🔑 进入 API 控制台
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 底部按钮 */}
              <div style={footerStyle}>
                {currentStep > 1 ? (
                  <button style={outlineBtn} onClick={() => setCurrentStep((s) => s - 1)}>
                    上一步
                  </button>
                ) : (
                  <div />
                )}
                <div style={footerRightStyle}>
                  {currentStep < 3 && (
                    <button style={textBtn} onClick={close}>
                      跳过引导
                    </button>
                  )}
                  {currentStep < 3 && (
                    <button style={primaryBtn} onClick={() => setCurrentStep((s) => s + 1)}>
                      下一步
                    </button>
                  )}
                  {currentStep === 3 && (
                    <button style={primaryBtn} onClick={handleFinish}>
                      完成 🎉
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
