import { type CanvasEmptyLauncherActionKey } from "./CanvasEmptyLauncher";
import { handleCanvasEmptyLauncherAction as dispatchCanvasEmptyLauncherAction } from "./canvasEmptyLauncherAction";
import { type NodeType } from "./canvasMediaTypes";

export interface CanvasEmptyLauncherActionsDependencies {
  startQuickCharacterThreeView: () => void;
  createNodeAt: (type: NodeType, worldX: number, worldY: number) => string | undefined;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
}

export function createCanvasEmptyLauncherActions({
  startQuickCharacterThreeView,
  createNodeAt,
  setStatus,
}: CanvasEmptyLauncherActionsDependencies) {
function handleCanvasEmptyLauncherAction(action: CanvasEmptyLauncherActionKey) {
    dispatchCanvasEmptyLauncherAction(action, {
      startRole: startQuickCharacterThreeView,
      createStory: () => { createNodeAt("text", 0, 0); setStatus("已创建真实故事脚本节点，请输入主题并选择文本模型"); },
      createImage: () => { createNodeAt("video", 0, 0); setStatus("已创建首帧图生视频节点"); },
    });
  }
  return { handleCanvasEmptyLauncherAction };
}
