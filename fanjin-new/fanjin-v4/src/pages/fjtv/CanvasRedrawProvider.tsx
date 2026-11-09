import { createContext, useContext, useState, type ReactNode, type Dispatch, type SetStateAction, type RefObject } from "react";
import { Palette } from "lucide-react";
import type { NodeData, EdgeData } from "./canvasDataTypes";
import type { AiModelOption } from "@/lib/api";
import { createNode } from "./canvasNodeDefaults";
import { getCanvasImagePreviewUrl, getNodeImageDisplayUrl } from "./canvasAssetPresentation";
import { getNodeVideoPosterUrl } from "./canvasVideoPreview";
import { isAiModelSelectable, normalizeVideoResolutionForModel } from "./canvasModelDefinitions";
import { isCanvasCatalogVideoModeSupported } from "./canvasCatalogContract";
import { addConnectedRedrawAssets, getRedrawInputs } from "../../features/video-redraw/redrawGraph";
import { buildRedrawPlan, createRedrawDraft, type RedrawDraft, type RedrawSource } from "../../features/video-redraw/redrawDraft";
import { VideoRedrawPanel } from "../../features/video-redraw/VideoRedrawPanel";
import { RedrawNodeCard } from "../../features/video-redraw/RedrawNodeCard";

type Actions = { create: (x:number,y:number,inputIds?:string[])=>void; open:(node:NodeData)=>void; nodes:NodeData[]; edges:EdgeData[]; selectedNodeIds:string[]; dark:boolean };
const Context = createContext<Actions | null>(null);
export const useCanvasRedraw = () => useContext(Context);
export function CanvasRedrawProvider({children,nodes,edges,nodesRef,latestCanvasSaveInputRef,availableModels,setNodes,setEdges,setStatus,setSelectedNodeIds,setSelectedEdgeIds,setActiveNodeId,persistCanvas,recordMutation,closeCreationMenu,studioChrome,canvasMeta,activeProjectContextId,videoNodeDurations,canvasColorMode,selectedNodeIds}: {
 children:ReactNode; nodes:NodeData[]; edges:EdgeData[]; nodesRef:RefObject<NodeData[]>; latestCanvasSaveInputRef:RefObject<{edges:EdgeData[]}>; availableModels:AiModelOption[];
 setNodes:Dispatch<SetStateAction<NodeData[]>>;setEdges:Dispatch<SetStateAction<EdgeData[]>>;setStatus:Dispatch<SetStateAction<string>>;setSelectedNodeIds:Dispatch<SetStateAction<string[]>>;setSelectedEdgeIds:Dispatch<SetStateAction<string[]>>;setActiveNodeId:Dispatch<SetStateAction<string|null>>;
 persistCanvas:(nodes:NodeData[],edges?:EdgeData[])=>Promise<unknown>;recordMutation:(nodes:NodeData[],edges:EdgeData[])=>void;closeCreationMenu:()=>void;studioChrome:boolean;canvasMeta:{canvasId?:number|string|null};activeProjectContextId:string|null;videoNodeDurations:Record<string,number>;canvasColorMode:string;selectedNodeIds:string[];
}) {
 const [redrawSourceNodeId,setRedrawSourceNodeId]=useState<string|null>(null);
 const [redrawEditingNodeId,setRedrawEditingNodeId]=useState<string|null>(null);
  function createStandaloneRedrawNode(worldX: number, worldY: number, inputIds: string[] = []) {
    if (studioChrome && (!canvasMeta.canvasId || !activeProjectContextId)) { setStatus("请先打开真实画布，再添加转绘节点"); return; }
    const inputs = nodesRef.current.filter(node => inputIds.includes(node.id) && (node.type === "image" || node.type === "video"));
    if (inputs.filter(node => node.type === "video").length > 1) { setStatus("一个转绘节点只编辑一段原片，请只选择一个视频和需要的参考图片"); return; }
    const model = availableModels.find(model => model.type === "video" && isAiModelSelectable(model) && isCanvasCatalogVideoModeSupported(model, "video_edit"));
    const id = `node_redraw_${crypto.randomUUID()}`;
    const source = inputs.find(node => node.type === "video");
    const draft = addConnectedRedrawAssets({ ...createRedrawDraft(model?.id || ""), mappings: [] }, inputs.filter(node => node.type === "image").map(node => node.id));
    const next: NodeData = { ...createNode(id, "video", worldX, worldY), title: "转绘节点", titleCustomized: true,
      model: model?.id || "", videoMode: "video_edit", videoWorkflow: "redraw", duration: "-1", videoRedrawDraft: draft,
      videoRedrawSourceNodeId: source?.id, suppressEmptyTryActions: true };
    const nextNodes = [...nodesRef.current, next];
    const nextEdges: EdgeData[] = [...latestCanvasSaveInputRef.current.edges, ...inputs.map((node, index) => ({ id: `edge_${id}_${index}`, fromNodeId: node.id, toNodeId: id, fromSide: "right" as const, toSide: "left" as const }))];
    recordMutation(nextNodes, nextEdges);
    nodesRef.current = nextNodes; setNodes(nextNodes); setEdges(nextEdges);
    setSelectedNodeIds([id]); setSelectedEdgeIds([]); setActiveNodeId(id); closeCreationMenu();
    setStatus(source ? "已创建转绘节点，打开配置为参考图片指定替换用途" : "已创建转绘节点；从原片和参考图片右侧连入此节点，再配置替换关系");
  }

  function openVideoRedraw(node: NodeData) {
    if (node.videoWorkflow === "redraw" || node.videoRedrawSourceNodeId) {
      const inputs = getRedrawInputs(node.id, nodesRef.current, latestCanvasSaveInputRef.current.edges);
      if (inputs.error || !inputs.source) { setStatus(inputs.error); return; }
      setRedrawSourceNodeId(inputs.source.id); setRedrawEditingNodeId(node.id);
    } else { setRedrawSourceNodeId(node.id); setRedrawEditingNodeId(null); }
  }
  const redrawEditingNode = nodes.find(node => node.id === redrawEditingNodeId);
  const redrawInputs = redrawEditingNode ? getRedrawInputs(redrawEditingNode.id, nodes, edges) : null;
  const redrawSourceNode = redrawEditingNode ? redrawInputs?.source : nodes.find(node => node.id === redrawSourceNodeId);
  const redrawAssets = (redrawInputs ? redrawInputs.images : nodes).filter(node => node.type === "image" && getNodeImageDisplayUrl(node)).map(node => ({ id: node.id, name: node.title, imageUrl: getNodeImageDisplayUrl(node) }));
  const redrawModels = availableModels.filter(model => model.type === "video" && isAiModelSelectable(model) && isCanvasCatalogVideoModeSupported(model, "video_edit"));
  const redrawSource: RedrawSource | null = redrawSourceNode ? {
    id: redrawSourceNode.id, title: redrawSourceNode.title,
    url: redrawSourceNode.localVideoUrl || redrawSourceNode.videoUrl || "",
    poster: getNodeVideoPosterUrl(redrawSourceNode, getCanvasImagePreviewUrl),
    duration: (redrawSourceNode.mediaDurationMs || 0) / 1000 || videoNodeDurations[redrawSourceNode.id] || redrawSourceNode.videoStoryAnalysis?.duration || 0,
    shots: (redrawSourceNode.videoStoryAnalysis?.rows || []).map((shot, index) => ({
      id: shot.id || `shot-${index}`, title: `镜头 ${shot.shot}`, start: shot.startTime, end: shot.endTime,
      description: shot.visualDescription || shot.narrative, poster: shot.keyframeUrl,
    })),
  } : null;
  async function saveVideoRedrawDraft(draft: RedrawDraft) {
    if (redrawEditingNodeId) return createVideoRedrawNode(draft);
    if (!redrawSourceNodeId || !nodesRef.current.some(node => node.id === redrawSourceNodeId)) throw new Error("原视频已移除，请重新选择。");
    const nextNodes = nodesRef.current.map(node => node.id === redrawSourceNodeId ? { ...node, videoRedrawDraft: draft } : node);
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    const saved = await persistCanvas(nextNodes);
    if (!saved) throw new Error("配置尚未保存到服务器，请检查登录或画布冲突后重试。当前修改仍保留在画布中。");
  }
  async function createVideoRedrawNode(draft: RedrawDraft) {
    const currentInputs = redrawEditingNodeId ? getRedrawInputs(redrawEditingNodeId, nodesRef.current, latestCanvasSaveInputRef.current.edges) : null;
    if (currentInputs?.error) throw new Error(currentInputs.error);
    const source = currentInputs?.source || nodesRef.current.find(node => node.id === redrawSourceNodeId);
    if (!source || !(source.videoUrl || source.localVideoUrl)) throw new Error("请先上传原视频。");
    const model = redrawModels.find(item => item.id === draft.modelId);
    if (!model) throw new Error("该模型不支持原片编辑，请重新选择，不会自动降级为重生成。");
    const plan = buildRedrawPlan(draft, redrawAssets);
    const existing = redrawEditingNodeId ? nodesRef.current.find(node => node.id === redrawEditingNodeId) : null;
    if (redrawEditingNodeId && !existing) throw new Error("转绘节点已移除，请从原片重新打开。");
    if (existing?.isGenerating || existing?.generationState === "submitting" || existing?.generationState === "processing") throw new Error("该转绘节点正在生成，请等待完成后再修改配置。");
    const id = existing?.id || `node_redraw_${crypto.randomUUID()}`;
    const next: NodeData = {
      ...createNode(id, "video", source.x + source.width + 100 + source.width / 2, source.y + source.height / 2),
      ...existing,
      title: existing?.title || `转绘 · ${source.title}`, titleCustomized: true,
      width: existing?.width || source.width, height: existing?.height || source.height, ratio: source.ratio,
      model: model.id, videoMode: plan.mode, duration: plan.duration,
      resolution: normalizeVideoResolutionForModel(model.id, source.resolution || "720P", model),
      videoGenerateAudio: true, prompt: plan.prompt, videoWorkflow: "redraw", videoRedrawSourceNodeId: source.id, videoRedrawDraft: draft,
    };
    const patchedNodes = nodesRef.current.map(node => node.id === source.id ? { ...node, videoRedrawDraft: draft } : node.id === id ? next : node);
    const nextNodes = existing ? patchedNodes : [...patchedNodes, next];
    const nextEdges: EdgeData[] = [...latestCanvasSaveInputRef.current.edges.filter(edge => edge.toNodeId !== id), ...[source.id, ...plan.referenceIds].map((fromNodeId, index) => ({ id: `edge_${id}_${index}`, fromNodeId, toNodeId: id, fromSide: "right" as const, toSide: "left" as const }))];
    nodesRef.current = nextNodes; setNodes(nextNodes); setEdges(nextEdges);
    setRedrawEditingNodeId(id);
    setActiveNodeId(id); setSelectedNodeIds([id]); setSelectedEdgeIds([]);
    const saved = await persistCanvas(nextNodes, nextEdges);
    if (!saved) throw new Error("转绘节点已留在当前画布，但尚未保存到服务器。请先解决登录或画布冲突，避免重复创建。");
    setStatus(existing ? "转绘节点已更新，尚未提交生成" : "已创建原片编辑转绘节点，尚未提交生成；原片与替换资产已连接");
  }


 return <Context.Provider value={{create:createStandaloneRedrawNode,open:openVideoRedraw,nodes,edges,selectedNodeIds,dark:canvasColorMode==="dark"}}>{children}
      {redrawSource && redrawSourceNode ? <VideoRedrawPanel key={redrawSource.id}
        source={redrawSource} assets={redrawAssets} models={redrawModels.map(model => ({ id: model.id, name: model.name }))}
        initialDraft={redrawEditingNode ? addConnectedRedrawAssets(redrawEditingNode.videoRedrawDraft || createRedrawDraft(redrawEditingNode.model), redrawAssets.map(asset => asset.id)) : redrawSourceNode.videoRedrawDraft} editing={Boolean(redrawEditingNode)} assetsScope={redrawEditingNode ? "connected" : "canvas"} dark={canvasColorMode === "dark"}
        resultUrl={nodes.filter(node => node.videoRedrawSourceNodeId === redrawSource.id && node.videoUrl).at(-1)?.videoUrl}
        onClose={() => setRedrawSourceNodeId(null)} onSave={saveVideoRedrawDraft} onCreate={createVideoRedrawNode} /> : null}
</Context.Provider>;
}
export function CanvasRedrawButton({node,className}:{node:NodeData;className?:string}) {
 const actions=useCanvasRedraw(); if (!actions) return null;
 return <button type="button" className={className} disabled={Boolean(node.isGenerating)} onClick={()=>actions.open(node)}><Palette className="h-4 w-4"/><span>一键转绘</span></button>;
}
export function CanvasRedrawPlaceholder({node}:{node:NodeData}) {
 const actions=useCanvasRedraw(); if(!actions)return null;
 const inputs=getRedrawInputs(node.id,actions.nodes,actions.edges);
 return <RedrawNodeCard sourceTitle={inputs.source?.title} assets={inputs.images.map(item=>({id:item.id,name:item.title,imageUrl:getNodeImageDisplayUrl(item)}))} error={inputs.error} dark={actions.dark} onConfigure={()=>actions.open(node)}/>;
}
