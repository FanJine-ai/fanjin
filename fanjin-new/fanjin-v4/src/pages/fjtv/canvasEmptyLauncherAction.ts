import type { CanvasEmptyLauncherActionKey } from "./CanvasEmptyLauncher";

export function handleCanvasEmptyLauncherAction(action: CanvasEmptyLauncherActionKey, actions: { startRole: () => void; createStory: () => void; createImage: () => void }) {
  if (action === "role") return actions.startRole();
  if (action === "story") return actions.createStory();
  if (action === "image") return actions.createImage();
}
