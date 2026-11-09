import { useState } from "react";
import type { NodeType } from "./canvasMediaTypes";
interface Context {

}
export function useCanvasNodeSerialState({  }: Context) {
  const [nodeSerialCounter, setNodeSerialCounter] = useState<Record<NodeType, number>>({
    image: 0,
    video: 0,
    text: 0,
    audio: 0,
    compose: 0,
    script: 0,
  });

  return { nodeSerialCounter, setNodeSerialCounter };
}
