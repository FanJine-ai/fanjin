import type { Dispatch, SetStateAction, RefObject, ReactNode, JSX } from "react";
import { formatVideoStorySeconds } from "./CanvasVideoStoryTable";
import type { StoryboardGroupType, VideoStoryAnalysis, VideoStoryTaskState, NodeData, EdgeData, GroupData, CanvasMetaState } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { api } from "@/lib/api";

export interface CanvasVideoStoryControllerDependencies {
  nodesRef: RefObject<NodeData[]>;
  groups: GroupData[];
  setActiveGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setStatus: Dispatch<SetStateAction<string>>;
  createNode: (id: string, type: NodeType, centerX: number, centerY: number) => NodeData;
  buildStoryboardGroupData: (stamp: number, nodeIds: string[], title: string, groupType: StoryboardGroupType, rows: number, cols: number, ratio: RatioKey) => GroupData;
  nodes: NodeData[];
  edges: EdgeData[];
  setNodes: Dispatch<SetStateAction<NodeData[]>>;
  setEdges: Dispatch<SetStateAction<EdgeData[]>>;
  setGroups: Dispatch<SetStateAction<GroupData[]>>;
  setSelectedEdgeIds: Dispatch<SetStateAction<string[]>>;
  persistCanvas: (nextNodes?: NodeData[], nextEdges?: EdgeData[], nextName?: string, nextGroups?: GroupData[]) => Promise<string | null>;
  canvasMeta: CanvasMetaState;
  videoStoryPollInFlightRef: RefObject<Set<number>>;
  ensureApiKeyReady: () => boolean;
  currentProjectId: string | null;
  videoStoryAttemptId: () => `${string}-${string}-${string}-${string}-${string}`;
}

export function createCanvasVideoStoryController(deps: CanvasVideoStoryControllerDependencies) {
  const { nodesRef, groups, setActiveGroupId, setSelectedNodeIds, setActiveNodeId, setStatus, createNode, buildStoryboardGroupData, nodes, edges, setNodes, setEdges, setGroups, setSelectedEdgeIds, persistCanvas, canvasMeta, videoStoryPollInFlightRef, ensureApiKeyReady, currentProjectId, videoStoryAttemptId } = deps;
function updateVideoStoryCell(nodeId: string, rowIndex: number, key: string, value: string) {
    const editableKeys = new Set([
      "visualDescription", "narrative", "shotSize", "cameraAngle", "cameraMovement",
      "focusDepth", "lighting", "backgroundMusic", "voiceSound", "subtitle",
      "imagePrompt", "videoMotionPrompt", "keywords",
    ]);
    if (!editableKeys.has(key)) return;
    const node = nodesRef.current.find((item) => item.id === nodeId);
    const analysis = node?.videoStoryAnalysis;
    if (!node || !analysis || !analysis.rows[rowIndex]) return;
    const rows = analysis.rows.map((row, index) => index === rowIndex ? { ...row, [key]: value } : row);
    patchVideoStoryNode(nodeId, { videoStoryAnalysis: { ...analysis, rows } }, { persist: true });
  }

function writeVideoStoryToStoryboard(sourceNode: NodeData) {
    const analysis = sourceNode.videoStoryAnalysis;
    if (!analysis?.rows?.length) return;
    const existingGroup = groups.find((group) => group.id === sourceNode.videoStoryStoryboardGroupId);
    if (existingGroup) {
      setActiveGroupId(existingGroup.id);
      setSelectedNodeIds(existingGroup.nodeIds);
      setActiveNodeId(null);
      setStatus("该拉片结果已经写入分镜组");
      return;
    }
    const stamp = Date.now();
    const columns = Math.min(4, Math.max(1, analysis.rows.length));
    const rowCount = Math.ceil(analysis.rows.length / columns);
    const slotWidth = 260;
    const slotHeight = 146;
    const spacing = 18;
    const startX = sourceNode.x + sourceNode.width + 96;
    const startY = sourceNode.y;
    const createdNodes: NodeData[] = analysis.rows.map((shot, index) => {
      const id = `node_${stamp}_video_story_${index}`;
      const base = createNode(id, "image", 0, 0);
      const semantic = [
        shot.visualDescription,
        shot.narrative,
        shot.shotSize,
        shot.cameraAngle,
        shot.cameraMovement,
        shot.lighting,
        shot.subtitle,
      ].map((value) => String(value || "").trim())
        .filter((value) => value && value !== "待人工补充")
        .join("；");
      return {
        ...base,
        title: `拉片镜头 ${shot.shot}`,
        titleCustomized: true,
        x: startX + (index % columns) * (slotWidth + spacing),
        y: startY + Math.floor(index / columns) * (slotHeight + spacing),
        width: slotWidth,
        height: slotHeight,
        ratio: "16:9",
        prompt: semantic || `来源时间码 ${formatVideoStorySeconds(shot.startTime)}-${formatVideoStorySeconds(shot.endTime)} 秒`,
        imageUrl: shot.keyframeUrl || "",
        primaryImageUrl: shot.keyframeUrl || "",
        referenceAssetUri: shot.keyframeAssetId ? `asset://${shot.keyframeAssetId}` : undefined,
        assetVersionId: shot.keyframeAssetVersionId,
        taskStatus: "success",
        generationState: "idle",
        isGenerating: false,
        storyboardSlotOrder: index,
        storyboardSlotPlaceholder: false,
        storyboardSlotFilledByUser: true,
      };
    });
    const nextGroup = buildStoryboardGroupData(
      stamp,
      createdNodes.map((node) => node.id),
      `${analysis.title || sourceNode.title} · 拉片分镜`,
      "storyboard",
      rowCount,
      columns,
      "16:9",
    );
    nextGroup.storyboardShowOrder = true;
    const nextEdge: EdgeData | null = createdNodes[0] ? {
      id: `edge_${stamp}_video_story_source`,
      fromNodeId: sourceNode.id,
      fromSide: "right",
      toNodeId: createdNodes[0].id,
      toSide: "left",
    } : null;
    const nextNodes = [
      ...nodes.map((node) => node.id === sourceNode.id
        ? { ...node, videoStoryStoryboardGroupId: nextGroup.id }
        : node),
      ...createdNodes,
    ];
    const nextEdges = nextEdge ? [...edges, nextEdge] : [...edges];
    const nextGroups = [...groups, nextGroup];
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(nextGroup.nodeIds);
    setSelectedEdgeIds(nextEdge ? [nextEdge.id] : []);
    setActiveGroupId(nextGroup.id);
    setActiveNodeId(null);
    void persistCanvas(nextNodes, nextEdges, canvasMeta.name, nextGroups);
    setStatus(`已写入 ${createdNodes.length} 个新分镜；原视频和已有分镜未被覆盖`);
  }

function patchVideoStoryNode(
    nodeId: string,
    patch: Partial<NodeData>,
    options: { persist?: boolean } = {},
  ) {
    let nextNodes: NodeData[] | null = null;
    setNodes((previous) => {
      nextNodes = previous.map((node) => node.id === nodeId ? { ...node, ...patch } : node);
      return nextNodes;
    });
    if (options.persist) {
      window.setTimeout(() => {
        if (nextNodes) void persistCanvas(nextNodes, edges, canvasMeta.name, groups);
      }, 40);
    }
  }

async function pollVideoStoryAnalysis(nodeId: string, projectId: number, taskId: number) {
    if (videoStoryPollInFlightRef.current.has(taskId)) return;
    videoStoryPollInFlightRef.current.add(taskId);
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const tasks = await api.queryVideoStoryAnalysisTasks({ projectId, taskIds: [taskId] });
        const task = Array.isArray(tasks) ? tasks[0] : null;
        if (!task || Number(task.taskId) !== taskId) throw new Error("逐帧拉片任务不存在或无权访问");
        const state = String(task.state || "") as VideoStoryTaskState;
        const analysis = task.analysis as VideoStoryAnalysis | null | undefined;
        if (state === "succeeded") {
          if (!analysis || !Array.isArray(analysis.rows) || analysis.rows.length === 0) {
            throw new Error("逐帧拉片完成但没有可用镜头结果");
          }
          patchVideoStoryNode(nodeId, {
            videoStoryAnalyzing: false,
            videoStoryTaskState: "succeeded",
            videoStoryFailureReason: undefined,
            videoStoryAnalysis: analysis,
          }, { persist: true });
          setStatus(`逐帧拉片完成：${analysis.rows.length} 个镜头 · 本地分析 0 GU`);
          return;
        }
        if (state === "failed" || state === "cancelled") {
          patchVideoStoryNode(nodeId, {
            videoStoryAnalyzing: false,
            videoStoryTaskState: state,
            videoStoryFailureReason: String(task.reason || (state === "cancelled" ? "逐帧拉片已取消" : "逐帧拉片失败")),
          }, { persist: true });
          setStatus(String(task.reason || (state === "cancelled" ? "逐帧拉片已取消" : "逐帧拉片失败")));
          return;
        }
        patchVideoStoryNode(nodeId, {
          videoStoryAnalyzing: true,
          videoStoryTaskState: state,
          videoStoryFailureReason: undefined,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 1_200));
      }
      const message = "逐帧拉片仍在后端执行；可继续查询或刷新页面恢复，系统不会重复提交";
      patchVideoStoryNode(nodeId, {
        videoStoryAnalyzing: false,
        videoStoryFailureReason: message,
      }, { persist: true });
      setStatus(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "状态查询失败";
      const message = `任务状态暂时无法确认：${detail}。可继续查询或刷新页面恢复，系统不会重复提交。`;
      patchVideoStoryNode(nodeId, {
        videoStoryAnalyzing: false,
        videoStoryFailureReason: message,
      }, { persist: true });
      setStatus(message);
    } finally {
      videoStoryPollInFlightRef.current.delete(taskId);
    }
  }

async function submitVideoStoryAnalysis(sourceNode: NodeData, retryOfTaskId?: number) {
    if (!ensureApiKeyReady()) return;
    if (sourceNode.type !== "video" || sourceNode.videoStoryAnalyzing) return;
    const projectId = Number(currentProjectId || canvasMeta.projectId || 0);
    const assetVersionId = Number(sourceNode.assetVersionId || 0);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      setStatus("请先选择项目，再提交逐帧拉片");
      return;
    }
    if (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0) {
      setStatus("该视频尚未进入项目受控资产，请先上传或重新选择项目视频");
      return;
    }
    const rightsConfirmed = window.confirm("请确认：你拥有该视频的分析与再创作权利。逐帧拉片只做本地技术分析，不产生模型费用。是否继续？");
    if (!rightsConfirmed) {
      setStatus("未确认素材权利，已取消提交");
      return;
    }
    const attemptId = videoStoryAttemptId();
    try {
      patchVideoStoryNode(sourceNode.id, {
        videoStoryAnalyzing: true,
        videoStoryTaskState: "queued",
        videoStoryFailureReason: undefined,
        videoStoryAttemptId: attemptId,
      }, { persist: true });
      setStatus("逐帧拉片任务提交中");
      const result = await api.analyzeVideoStory({
        projectId,
        assetVersionId,
        title: sourceNode.title,
        maximumShots: 24,
        rightsConfirmed: true,
        ...(retryOfTaskId ? { retryOfTaskId } : {}),
        idempotencyKey: `canvas-video-story:${sourceNode.id}:${attemptId}`,
      });
      const task = (result as any)?.task || (result as any)?.result?.task;
      const taskId = Number(task?.taskId || 0);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("逐帧拉片响应缺少任务编号");
      patchVideoStoryNode(sourceNode.id, {
        videoStoryTaskId: taskId,
        videoStoryTaskState: String(task.state || "queued") as VideoStoryTaskState,
        videoStoryAnalyzing: true,
      }, { persist: true });
      setStatus(`逐帧拉片任务 ${taskId} 已排队 · 本地分析 0 GU`);
      await pollVideoStoryAnalysis(sourceNode.id, projectId, taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "逐帧拉片提交失败";
      patchVideoStoryNode(sourceNode.id, {
        videoStoryAnalyzing: false,
        videoStoryTaskState: "failed",
        videoStoryFailureReason: message,
      }, { persist: true });
      setStatus(message);
    }
  }

async function cancelVideoStoryAnalysis(node: NodeData) {
    const projectId = Number(currentProjectId || canvasMeta.projectId || 0);
    const taskId = Number(node.videoStoryTaskId || 0);
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(taskId) || taskId <= 0) return;
    try {
      const result = await api.cancelVideoStoryAnalysis({ projectId, taskId });
      const task = (result as any)?.task;
      patchVideoStoryNode(node.id, {
        videoStoryAnalyzing: false,
        videoStoryTaskState: String(task?.state || "cancelled") as VideoStoryTaskState,
        videoStoryFailureReason: String(task?.reason || "逐帧拉片已取消"),
      }, { persist: true });
      setStatus(String(task?.reason || "逐帧拉片已取消"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "取消逐帧拉片失败");
    }
  }
  return { updateVideoStoryCell, writeVideoStoryToStoryboard, patchVideoStoryNode, pollVideoStoryAnalysis, submitVideoStoryAnalysis, cancelVideoStoryAnalysis };
}
