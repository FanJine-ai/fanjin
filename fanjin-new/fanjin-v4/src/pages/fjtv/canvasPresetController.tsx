import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import type { NodeData, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";

export interface CanvasPresetControllerDependencies {
  nodeMap: Map<string, NodeData>;
  TEXT_PRESET_VIDEO_PROMPT: "电影级人物镜头 雨夜街头，霓虹灯反射在湿漉漉的地面，女主撑伞站在路灯下，表情克制而坚定，镜头环绕人物360度缓慢移动，浅景深，光影对比强烈，电影级调色，真实皮肤质感";
  baseModel: (type: NodeType) => "timeline-compose" | "";
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  nodes: NodeData[];
  edges: EdgeData[];
  groups: GroupData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setEditingTextNodeId: Dispatch<SetStateAction<string | null>>;
  setTextEditorDraft: Dispatch<SetStateAction<string>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  setStatus: Dispatch<SetStateAction<string>>;
}

export function createCanvasPresetController(deps: CanvasPresetControllerDependencies) {
  const { nodeMap, TEXT_PRESET_VIDEO_PROMPT, baseModel, createNode, nodes, edges, groups, setNodes, setEdges, setGroups, setSelectedNodeIds, setSelectedEdgeIds, setActiveGroupId, setActiveNodeId, setEditingTextNodeId, setTextEditorDraft, persistCanvas, canvasMeta, setStatus } = deps;
function createTextVideoPresetGroup(sourceNodeId: string) {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (!sourceNode || sourceNode.type !== "text") return;

    const stamp = Date.now();
    const partnerId = `node_${stamp}_preset_partner`;
    const groupId = `group_${stamp}_preset`;

    const nextSourceNode: NodeData = {
      ...sourceNode,
      title: sourceNode.title || "文本节点 2",
      titleCustomized: true,
      prompt: TEXT_PRESET_VIDEO_PROMPT,
      outputText: TEXT_PRESET_VIDEO_PROMPT,
      textVisited: true,
      model: baseModel("text"),
      textHeading: "body",
      textBold: true,
      textFontSize: 18,
      x: sourceNode.x,
      y: sourceNode.y + 68,
      width: 480,
      height: 270,
      ratio: "16:9",
    };

    const partnerNode: NodeData = {
      ...createNode(partnerId, "video", nextSourceNode.x + nextSourceNode.width + 76, sourceNode.y + 68),
      title: "视频",
      titleCustomized: true,
      width: 845,
      height: 475,
      ratio: "16:9",
      prompt: "",
      outputText: undefined,
      model: "",
      resolution: "",
      duration: "5",
      isGenerating: false,
      generationState: "idle",
      taskStatus: "idle",
    };

    const nextEdge: EdgeData = {
      id: `edge_${stamp}_preset`,
      fromNodeId: nextSourceNode.id,
      fromSide: "right",
      toNodeId: partnerNode.id,
      toSide: "left",
    };

    const nextGroup: GroupData = {
      id: groupId,
      nodeIds: [nextSourceNode.id, partnerNode.id],
      layoutMode: "horizontal",
      themeColor: "#4a4a4d",
      title: "预设 - 文生视频",
    };

    const nextNodes = nodes.map((node) => (node.id === sourceNode.id ? nextSourceNode : node)).concat(partnerNode);
    const nextEdges = [...edges, nextEdge];
    const nextGroups = [...groups.filter((group) => !group.nodeIds.includes(sourceNode.id)), nextGroup];

    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(nextGroup.nodeIds);
    setSelectedEdgeIds([]);
    setActiveGroupId(groupId);
    setActiveNodeId(null);
    setEditingTextNodeId(null);
    setTextEditorDraft("");
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
  }

function createEmptyImageNode(id: string, title: string, x: number, y: number, width: number, height: number, ratio: RatioKey): NodeData {
    return {
      ...createNode(id, "image", x + width / 2, y + height / 2),
      title,
      titleCustomized: true,
      x,
      y,
      width,
      height,
      ratio,
      uploadState: "idle",
      taskStatus: "idle",
      generationState: "idle",
      isGenerating: false,
    };
  }

function createImageToImagePresetGroup(sourceNodeId: string, uploadedUrl: string, naturalWidth: number, naturalHeight: number, baseNodes?: NodeData[] | null) {
    const sourceNode = (baseNodes || nodes).find((item) => item.id === sourceNodeId) || nodeMap.get(sourceNodeId);
    if (!sourceNode || sourceNode.type !== "image") return;
    const stamp = Date.now();
    const targetId = `node_${stamp}_image_to_image`;
    const groupId = `group_${stamp}_image_to_image`;
    const spacing = 108;
    const sourceWidth = Math.max(320, Math.min(420, sourceNode.width));
    const sourceHeight = Math.max(320, Math.min(420, sourceNode.height));
    const nextSourceNode: NodeData = {
      ...sourceNode,
      title: sourceNode.title || "图片节点",
      titleCustomized: true,
      imageUrl: uploadedUrl,
      primaryImageUrl: uploadedUrl,
      mediaNaturalWidth: naturalWidth || sourceNode.mediaNaturalWidth,
      mediaNaturalHeight: naturalHeight || sourceNode.mediaNaturalHeight,
      x: sourceNode.x,
      y: sourceNode.y,
      width: sourceWidth,
      height: sourceHeight,
    };
    const targetNode: NodeData = {
      ...createNode(targetId, "image", nextSourceNode.x + sourceWidth + spacing + 185, nextSourceNode.y + 185),
      title: "图生图",
      titleCustomized: true,
      x: nextSourceNode.x + sourceWidth + spacing,
      y: nextSourceNode.y,
      width: 370,
      height: 370,
      ratio: "1:1",
      model: baseModel("image"),
      resolution: "2K",
      prompt: "",
      promptPlaceholder: "可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜",
    };
    const nextEdge: EdgeData = {
      id: `edge_${stamp}_image_to_image`,
      fromNodeId: nextSourceNode.id,
      fromSide: "right",
      toNodeId: targetNode.id,
      toSide: "left",
    };
    const nextGroup: GroupData = {
      id: groupId,
      nodeIds: [nextSourceNode.id, targetNode.id],
      layoutMode: "horizontal",
      themeColor: "#4a4a4d",
      title: "预设 - 图生图",
    };
    const sourceList = baseNodes || nodes;
    const nextNodes = sourceList.map((node) => (node.id === sourceNode.id ? nextSourceNode : node)).concat(targetNode);
    const nextEdges = [...edges, nextEdge];
    const nextGroups = [...groups.filter((group) => !group.nodeIds.includes(sourceNode.id)), nextGroup];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(nextGroup.nodeIds);
    setSelectedEdgeIds([nextEdge.id]);
    setActiveGroupId(groupId);
    setActiveNodeId(targetNode.id);
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
    return { nodes: nextNodes, edges: nextEdges, groups: nextGroups };
  }

function createVideoFramePresetGroup(sourceNodeId: string, mode: "first" | "firstLast") {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (!sourceNode || sourceNode.type !== "video") return;
    const stamp = Date.now();
    const groupId = `group_${stamp}_${mode === "first" ? "first_frame_video" : "first_last_frame_video"}`;
    const videoWidth = mode === "first" ? 746 : 580;
    const videoHeight = mode === "first" ? 420 : 326;
    const startX = sourceNode.x;
    const startY = sourceNode.y;
    const imageNodes =
      mode === "first"
        ? [createEmptyImageNode(`node_${stamp}_first_frame`, "上传首帧", startX, startY, 630, 420, "3:2")]
        : [
            createEmptyImageNode(`node_${stamp}_first_frame`, "上传首帧", startX, startY, 438, 327, "4:3"),
            createEmptyImageNode(`node_${stamp}_last_frame`, "上传尾帧", startX, startY + 376, 438, 324, "4:3"),
          ];
    const videoX = mode === "first" ? startX + 720 : startX + 650;
    const videoY = mode === "first" ? startY : startY + 183;
    const nextVideoNode: NodeData = {
      ...sourceNode,
      title: sourceNode.title || "视频节点",
      titleCustomized: true,
      x: videoX,
      y: videoY,
      width: videoWidth,
      height: videoHeight,
      ratio: "16:9",
      resolution: "720P",
      duration: "5",
      prompt: "",
      videoGenerateAudio: true,
      videoMode: mode === "first" ? "image_to_video" : "first_last_frame",
      videoUrl: undefined,
      localVideoUrl: undefined,
      videoPosterUrl: undefined,
      suppressEmptyTryActions: true,
    };
    const nextEdges = [
      ...edges,
      ...imageNodes.map((imageNode, index) => ({
        id: `edge_${stamp}_${mode}_${index}`,
        fromNodeId: imageNode.id,
        fromSide: "right" as const,
        toNodeId: nextVideoNode.id,
        toSide: "left" as const,
      })),
    ];
    const nextGroup: GroupData = {
      id: groupId,
      nodeIds: [...imageNodes.map((item) => item.id), nextVideoNode.id],
      layoutMode: "horizontal",
      themeColor: "#4a4a4d",
      title: mode === "first" ? "预设 - 首帧生成视频" : "预设 - 首尾帧生成视频",
    };
    const nextNodes = nodes.map((node) => (node.id === sourceNode.id ? nextVideoNode : node)).concat(imageNodes);
    const nextGroups = [...groups.filter((group) => !group.nodeIds.includes(sourceNode.id)), nextGroup];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds([imageNodes[0].id]);
    setSelectedEdgeIds(nextEdges.slice(-imageNodes.length).map((edge) => edge.id));
    setActiveGroupId(groupId);
    setActiveNodeId(imageNodes[0].id);
    setStatus(mode === "first" ? "请上传真实首帧图片" : "请分别上传真实首帧与尾帧图片");
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
  }
  return { createTextVideoPresetGroup, createEmptyImageNode, createImageToImagePresetGroup, createVideoFramePresetGroup };
}
