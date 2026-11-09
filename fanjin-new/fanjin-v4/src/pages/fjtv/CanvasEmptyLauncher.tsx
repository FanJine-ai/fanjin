import type { CSSProperties } from "react";
import { ArrowRight, FileImage, Image as ImageIcon, NotebookTabs } from "lucide-react";
import type { CanvasEmptyLauncherColumnCount } from "./canvasAdaptiveLayout";
import "./CanvasEmptyLauncher.css";

export type CanvasEmptyLauncherActionKey = "story" | "role" | "image";

export const CANVAS_EMPTY_LAUNCHER_ACTIONS = [
  {
    key: "story",
    label: "故事脚本生成",
    description: "从主题快速搭建脚本结构",
    tone: "blue",
  },
  {
    key: "role",
    label: "角色三视图",
    description: "上传角色参考图后生成统一视图",
    tone: "violet",
  },
  {
    key: "image",
    label: "首帧图生视频",
    description: "让首帧自然延展为动态画面",
    tone: "cyan",
  },
] as const;

const launcherIcons = {
  story: NotebookTabs,
  role: FileImage,
  image: ImageIcon,
} as const;

export interface CanvasEmptyLauncherProps {
  logoSrc: string;
  columns: CanvasEmptyLauncherColumnCount;
  leftOffset: number;
  onAction: (action: CanvasEmptyLauncherActionKey) => void;
}

export function CanvasEmptyLauncher({
  logoSrc,
  columns,
  leftOffset,
  onAction,
}: CanvasEmptyLauncherProps) {
  return (
    <section
      data-canvas-empty-launcher
      data-columns={columns}
      className="canvas-empty-launcher"
      style={{ "--canvas-empty-launcher-left": `${Math.max(0, leftOffset)}px` } as CSSProperties}
      aria-label="选择创作起点"
    >
      <div className="canvas-empty-launcher-inner">
        <header className="canvas-empty-launcher-heading">
          <img className="canvas-empty-launcher-logo" src={logoSrc} alt="" aria-hidden="true" />
          <div>
            <h2>选择创作起点</h2>
            <p>也可以双击空白处自由添加节点</p>
          </div>
        </header>

        <div className="canvas-empty-launcher-grid">
          {CANVAS_EMPTY_LAUNCHER_ACTIONS.map((item) => {
            const Icon = launcherIcons[item.key];
            return (
              <button
                key={item.key}
                type="button"
                data-canvas-empty-action={item.key}
                data-tone={item.tone}
                aria-label={item.label}
                className="canvas-empty-launcher-card"
                onClick={() => onAction(item.key)}
              >
                <span className="canvas-empty-launcher-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="canvas-empty-launcher-copy">
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                </span>
                <span className="canvas-empty-launcher-go" aria-hidden="true">
                  <ArrowRight />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
