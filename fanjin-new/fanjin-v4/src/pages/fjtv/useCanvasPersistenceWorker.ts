import { useRef } from "react";
export function useCanvasPersistenceWorker({
  canvasRuntimeRefsModule,
  canvasProjectActionBindings,
  canvasGraphStateModule,
  canvasGroupStateModule,
  canvasMeta,
}: Pick<
  Parameters<
    typeof import("./useCanvasSaveHistoryEffects").useCanvasSaveHistoryEffects
  >[0],
  | "canvasRuntimeRefsModule"
  | "canvasProjectActionBindings"
  | "canvasGraphStateModule"
  | "canvasGroupStateModule"
  | "canvasMeta"
>) {
  canvasRuntimeRefsModule.canvasPersistWorkerRef.current = (request) =>
    canvasProjectActionBindings.persistCanvasOnce(
      request.nodes,
      request.edges,
      request.name,
      request.groups,
      request.contextEpoch,
    );

  // Async task completions must save the current graph, not the render that
  // started polling. Otherwise one result can restore another node's old state
  // or overwrite the loaded canvas name with the initial placeholder.
  const latestCanvasSaveInputRef = useRef({
    edges: canvasGraphStateModule.edges,
    groups: canvasGroupStateModule.groups,
    name: canvasMeta.name,
  });
  latestCanvasSaveInputRef.current = {
    edges: canvasGraphStateModule.edges,
    groups: canvasGroupStateModule.groups,
    name: canvasMeta.name,
  };

  return latestCanvasSaveInputRef;
}
