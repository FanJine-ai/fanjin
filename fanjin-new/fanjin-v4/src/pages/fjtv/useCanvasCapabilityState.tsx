import { useState } from "react";
import {
CANVAS_REAL_CAPABILITIES,
type CanvasRealCapabilities
} from "./canvasCapabilities";
interface Context {

}
export function useCanvasCapabilityState({  }: Context) {
  const [canvasCapabilities, setCanvasCapabilities] = useState<CanvasRealCapabilities>(
    () => ({ ...CANVAS_REAL_CAPABILITIES }),
  );
  return { canvasCapabilities, setCanvasCapabilities };
}
