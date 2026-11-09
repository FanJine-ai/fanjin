import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, Rocket, SlidersHorizontal, TerminalSquare } from "lucide-react";
import { Alert, Button, CodeBlock, ConsolePage, EmptyState, FormField, Input, ResponsiveSplit, Section, Select } from "../../ui/console";
import { useAuthorizedProjectSelection } from "../../hooks/useAuthorizedProjectSelection";
import { useDeveloperConfig } from "./useDeveloperConfig";
import {
  DEVELOPER_ENDPOINT_TYPES,
  type DeveloperEndpointType,
  useDeveloperCatalog,
  activeModels,
} from "./useDeveloperCatalog";
import { buildVideoDebugRequest } from "./videoDebugRequest";
import { useDeveloperVideoModels } from "./useDeveloperVideoModels";
import "./DeveloperConsole.css";

const DEBUG_ENDPOINT_LABELS: Record<DeveloperEndpointType, string> = {
  text: "文本对话",
  embedding: "文本 Embedding",
  multimodal_embedding: "多模态 Embedding",
  transcription: "音频转写（需上传文件）",
  tts: "语音合成",
  rerank: "重排",
  video_generation: "视频生成",
  image_generation: "图片生成",
};

const DEBUG_ENDPOINT_PATHS: Partial<Record<DeveloperEndpointType, string>> = {
  text: "/v1/chat/completions",
  embedding: "/v1/embeddings",
  multimodal_embedding: "/v1/embeddings",
  transcription: "/v1/audio/transcriptions",
  tts: "/v1/audio/speech",
  rerank: "/v1/rerank",
  video_generation: "/api/v3/contents/generations/tasks",
  image_generation: "/v1/images/generations",
};

function endpointForType(
  apiBaseUrl: string,
  configuredVideoEndpoint: string,
  endpointType: DeveloperEndpointType,
): string {
  if (endpointType === "video_generation" && configuredVideoEndpoint) {
    return configuredVideoEndpoint;
  }
  const base = apiBaseUrl.replace(/\/+$/, "");
  const path = DEBUG_ENDPOINT_PATHS[endpointType];
  return base && path ? `${base}${path}` : "";
}

function imageSizeForRatio(ratio: string): string {
  if (ratio === "9:16") return "1024x1792";
  if (ratio === "1:1") return "1024x1024";
  return "1792x1024";
}

function buildDebugRequestPayload(
  endpointType: DeveloperEndpointType,
  model: string,
  prompt: string,
  ratio: string,
): Record<string, unknown> {
  switch (endpointType) {
    case "text":
      return {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      };
    case "embedding":
      return { model, input: prompt };
    case "multimodal_embedding":
      return { model, input: [{ type: "text", text: prompt }] };
    case "tts":
      return { model, input: prompt, voice: "default", response_format: "mp3" };
    case "rerank":
      return { model, query: prompt, documents: [prompt] };
    case "image_generation":
      return { model, prompt, n: 1, size: imageSizeForRatio(ratio) };
    case "transcription":
      return {
        model,
        file: "<请上传音频文件后再发送>",
        response_format: "json",
      };
    case "video_generation":
      throw new Error("视频调试需要真实能力目录");
    default:
      throw new Error("不支持的调试能力");
  }
}

function debugModelLabel(endpointType: DeveloperEndpointType): string {
  // Keep the established “视频模型” wording for the empty-catalog warning
  // while the selector itself exposes the more precise capability label.
  return endpointType === "video_generation" ? "视频" : DEBUG_ENDPOINT_LABELS[endpointType];
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const node = document.createElement("textarea");
      node.value = text;
      node.className = "developerClipboardFallback";
      document.body.appendChild(node);
      node.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(node);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function ApiRequestPage() {
  const [modelSelection, setModelSelection] = useState({ workspaceId: "", value: "" });
  const [endpointSelection, setEndpointSelection] = useState({
    workspaceId: "",
    value: "video_generation" as DeveloperEndpointType,
  });
  const [apiKeyInput, setApiKeyInput] = useState({ workspaceId: "", value: "" });
  const [apiKeyRevision, setApiKeyRevision] = useState(0);
  const [prompt, setPrompt] = useState("生成一段雨夜便利店的电影感视频");
  const [ratio, setRatio] = useState("16:9");
  const [copyStatus, setCopyStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [debugResult, setDebugResult] = useState("");
  const [debugError, setDebugError] = useState("");
  const [debugContextKey, setDebugContextKey] = useState("");
  const debugRequestGeneration = useRef(0);
  const debugRequestController = useRef<AbortController | null>(null);
  const {
    catalog,
    loading: catalogLoading,
    error: catalogError,
    workspaceId,
    retry: retryCatalog,
  } = useDeveloperCatalog();
  const {
    config,
    loading: configLoading,
    error: configError,
    retry: retryConfig,
  } = useDeveloperConfig();
  const {
    projects,
    selectedProjectId: projectId,
    selectProject,
    loading: projectsLoading,
    error: projectsError,
    retry: retryProjects,
  } = useAuthorizedProjectSelection(workspaceId);
  const endpointOptions = useMemo(
    () => DEVELOPER_ENDPOINT_TYPES.filter((type) => activeModels(catalog, [type]).length > 0),
    [catalog],
  );
  const selectedEndpointType = endpointSelection.workspaceId === workspaceId
    ? endpointSelection.value
    : "video_generation";
  const endpointType = endpointOptions.includes(selectedEndpointType)
    ? selectedEndpointType
    : endpointOptions.includes("video_generation")
      ? "video_generation"
      : endpointOptions[0] || "video_generation";
  const endpoint = endpointForType(config.apiBaseUrl, config.endpoint, endpointType);
  const endpointRequiresFile = endpointType === "transcription";
  const modelOptions = useMemo(
    () => activeModels(catalog, [endpointType])
      .map((item) => ({ value: item.model, label: item.name || item.model })),
    [catalog, endpointType],
  );
  const selectedModel = modelSelection.workspaceId === workspaceId
    ? modelSelection.value
    : "";
  const model = selectedModel
    && modelOptions.some((option) => option.value === selectedModel)
    ? selectedModel
    : modelOptions[0]?.value || "";
  const apiKey = apiKeyInput.workspaceId === workspaceId
    ? apiKeyInput.value
    : "";
  const videoDirectory = useDeveloperVideoModels(workspaceId, endpointType === "video_generation");
  const videoCapability = videoDirectory.models.find((item) => item.id === model);
  const ratioOptions = endpointType === "video_generation" && videoCapability
    ? videoCapability.aspectRatios : ["16:9", "9:16", "1:1"];
  const selectedRatio = ratioOptions.some((option) => option === ratio)
    ? ratio : videoCapability?.defaultAspectRatio || ratioOptions[0];
  const requestPreparation = useMemo(() => {
    try {
      const payload = endpointType === "video_generation"
        ? buildVideoDebugRequest({ projectId, model, prompt, ratio: selectedRatio, capability: videoCapability })
        : buildDebugRequestPayload(endpointType, model, prompt, selectedRatio);
      return { payload, error: "" };
    } catch (error: unknown) {
      return { payload: null, error: error instanceof Error ? error.message : "请求参数无效" };
    }
  }, [endpointType, model, projectId, prompt, selectedRatio, videoCapability]);
  const requestBody = useMemo(
    () => requestPreparation.payload ? JSON.stringify(requestPreparation.payload, null, 2) : "",
    [requestPreparation.payload],
  );
  const preparationError = videoDirectory.loading ? "正在读取视频能力目录" : videoDirectory.error || requestPreparation.error;
  const requestContextKey = useMemo(
    () => JSON.stringify([workspaceId, endpointType, endpoint, projectId, model, prompt, ratio, requestBody, preparationError, apiKeyRevision]),
    [apiKeyRevision, endpoint, endpointType, model, projectId, prompt, ratio, requestBody, preparationError, workspaceId],
  );
  const requestContextKeyRef = useRef(requestContextKey);
  requestContextKeyRef.current = requestContextKey;
  const visibleDebugResult = debugContextKey === requestContextKey ? debugResult : "";
  const visibleDebugError = debugContextKey === requestContextKey ? debugError : "";
  const visibleSending = debugContextKey === requestContextKey && sending;

  useEffect(() => {
    setModelSelection({ workspaceId, value: model });
  }, [model, modelOptions, workspaceId]);

  useEffect(() => {
    setEndpointSelection({ workspaceId, value: endpointType });
  }, [endpointType, workspaceId]);

  useEffect(() => {
    // API keys belong to a workspace. The derived value above hides the old
    // key synchronously; this effect also prevents it from reappearing later.
    setApiKeyInput({ workspaceId, value: "" });
  }, [workspaceId]);

  useEffect(() => {
    debugRequestGeneration.current += 1;
    debugRequestController.current?.abort();
    debugRequestController.current = null;
    setDebugContextKey(requestContextKey);
    setSending(false);
    setDebugResult("");
    setDebugError("");
    return () => {
      debugRequestGeneration.current += 1;
      debugRequestController.current?.abort();
    };
  }, [requestContextKey]);

  async function copyRequestBody() {
    if (!projectId) {
      setCopyStatus("请先明确选择当前工作区内的活动项目");
      return;
    }
    if (preparationError || !requestBody) {
      setCopyStatus(preparationError || "请求参数无效");
      return;
    }
    const ok = await copyToClipboard(requestBody);
    setCopyStatus(ok ? "请求体已复制" : "复制失败，请手动复制");
  }

  async function sendDebugRequest() {
    if (!projectId) {
      setDebugContextKey(requestContextKey);
      setDebugError("请先明确选择当前工作区内的活动项目；没有项目权限时不能发送调试请求");
      setDebugResult("");
      return;
    }
    if (!endpoint || !model || !apiKey.trim()) {
      setDebugContextKey(requestContextKey);
      setDebugError("请先选择 active 模型并输入本次调试使用的 API 密钥");
      setDebugResult("");
      return;
    }
    if (preparationError || !requestBody) {
      setDebugContextKey(requestContextKey);
      setDebugError(preparationError || "请求参数无效");
      setDebugResult("");
      return;
    }
    if (endpointRequiresFile) {
      setDebugContextKey(requestContextKey);
      setDebugError("音频转写调试需要上传音频文件，当前页面暂不发送。");
      setDebugResult("");
      return;
    }
    debugRequestController.current?.abort();
    const controller = new AbortController();
    const generation = ++debugRequestGeneration.current;
    const submittedContextKey = requestContextKey;
    debugRequestController.current = controller;
    const isCurrentRequest = () => (
      !controller.signal.aborted
      && generation === debugRequestGeneration.current
      && requestContextKeyRef.current === submittedContextKey
    );
    setDebugContextKey(submittedContextKey);
    setSending(true);
    setDebugError("");
    setDebugResult("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey.trim().replace(/^Bearer\s+/i, ""),
          "Idempotency-Key": typeof globalThis.crypto?.randomUUID === "function"
            ? `developer-console:${globalThis.crypto.randomUUID()}`
            : `developer-console:${Date.now()}`,
        },
        body: requestBody,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || data?.message || `调试请求失败：${response.status}`);
      if (!isCurrentRequest()) return;
      setDebugResult(JSON.stringify(data, null, 2));
    } catch (err: any) {
      if (!isCurrentRequest()) return;
      setDebugError(err?.message || "调试请求失败");
    } finally {
      if (isCurrentRequest()) {
        setSending(false);
        if (debugRequestController.current === controller) {
          debugRequestController.current = null;
        }
      }
    }
  }

  return (
    <ConsolePage
      eyebrow="Developer API"
      title="API 调试"
      description="使用临时输入的 API 密钥调用真实 Endpoint；密钥不会保存。"
      primaryAction={(
        <div className="flex gap-2">
          <Button variant="secondary" icon={<FileCode2 size={16} />} onClick={() => void copyRequestBody()} disabled={!projectId || Boolean(preparationError)}>复制请求体</Button>
          <Button icon={<Rocket size={16} />} loading={visibleSending} onClick={() => void sendDebugRequest()} disabled={endpointRequiresFile || !endpoint || !projectId || !model || !apiKey.trim() || Boolean(preparationError)}>{visibleSending ? "发送中" : "发送调试请求"}</Button>
        </div>
      )}
    >
      {copyStatus ? <Alert tone={copyStatus.includes("失败") ? "danger" : "success"}>{copyStatus}</Alert> : null}
      {catalogLoading || configLoading || projectsLoading || videoDirectory.loading ? <Alert tone="info">正在读取当前工作区的活动项目、可调用模型与接口配置。</Alert> : null}
      {catalogError ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>模型目录读取失败：{catalogError}</span>
            <Button variant="secondary" size="compact" onClick={retryCatalog}>重试模型目录</Button>
          </div>
        </Alert>
      ) : null}
      {configError ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{configError}</span>
            <Button variant="secondary" size="compact" onClick={retryConfig}>重试接口配置</Button>
          </div>
        </Alert>
      ) : null}
      {projectsError ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{projectsError}</span>
            <Button variant="secondary" size="compact" onClick={retryProjects}>重试项目权限</Button>
          </div>
        </Alert>
      ) : null}
      {!projectsLoading && !projectsError && !projects.length
        ? <Alert tone="warning">当前工作区没有可用的活动项目；项目权限建立前已阻止发送调试请求。</Alert>
        : null}
      {!catalogLoading && !catalogError && !modelOptions.length
        ? <Alert tone="warning">当前工作区没有可调用的 active {debugModelLabel(endpointType)}模型。</Alert>
        : null}
      {endpointType === "video_generation" && !videoDirectory.loading && (videoDirectory.error || (projectId && requestPreparation.error)) ? (
        <Alert tone="danger">
          <span>{videoDirectory.error || requestPreparation.error}</span>
          {videoDirectory.error ? <Button variant="secondary" size="compact" onClick={videoDirectory.retry}>重试视频能力目录</Button> : null}
        </Alert>
      ) : null}
      {visibleDebugError ? <Alert tone="danger">{visibleDebugError}</Alert> : null}
      <ResponsiveSplit
        primary={
          <Section title="请求参数" icon={SlidersHorizontal}>
            <div className="developerRequestForm">
              <FormField
                id="developer-endpoint-type"
                label="能力类型"
                help="调试页会根据当前工作区 active 模型切换真实 Endpoint；音频转写需要上传文件，暂不在此页面发送。"
              >
                <Select
                  value={endpointType}
                  onChange={(event) => setEndpointSelection({
                    workspaceId,
                    value: event.target.value as DeveloperEndpointType,
                  })}
                >
                  {endpointOptions.map((type) => (
                    <option key={type} value={type}>{DEBUG_ENDPOINT_LABELS[type]}</option>
                  ))}
                </Select>
              </FormField>
              <FormField
                id="developer-project"
                label="活动项目"
                help="只列出当前工作区有权访问的活动项目；必须明确选择，不会自动推断。"
              >
                <Select
                  value={projectId === null ? "" : String(projectId)}
                  disabled={projectsLoading || !projects.length}
                  onChange={(event) => selectProject(event.target.value || null)}
                >
                  <option value="">请选择当前工作区项目</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}（ID: {project.id}）
                    </option>
                  ))}
                </Select>
              </FormField>
                <FormField id="developer-model" label="模型" help={modelOptions.length ? `仅列出当前工作区 active ${debugModelLabel(endpointType)}模型。` : "暂无可调用模型。"}>
                <Select
                  value={model}
                  disabled={!modelOptions.length}
                  onChange={(event) => setModelSelection({
                    workspaceId,
                    value: event.target.value,
                  })}
                >
                  {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              </FormField>
              <FormField id="developer-api-key" label="API 密钥" help="仅保存在当前输入框内，离开页面即丢弃。">
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder="fanjin_***"
                  onChange={(event) => {
                    setApiKeyInput({
                      workspaceId,
                      value: event.target.value,
                    });
                    // Fence every credential edit without copying the
                    // plaintext key into request identity state or refs.
                    setApiKeyRevision((revision) => revision + 1);
                  }}
                />
              </FormField>
              <FormField label="Prompt"><textarea className="developerRequestPrompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></FormField>
              <FormField label="比例"><Select value={selectedRatio} onChange={(event) => setRatio(event.target.value)}>{ratioOptions.map((option) => <option key={option}>{option}</option>)}</Select></FormField>
            </div>
          </Section>
        }
        secondary={<Section title="请求体预览" icon={FileCode2}><CodeBlock language="json">{requestBody}</CodeBlock></Section>}
      />
      <Section
        title="调试响应"
        description={endpoint ? `真实 Endpoint：${endpoint}` : "当前没有可用的真实 Endpoint。"}
        icon={TerminalSquare}
      >
        {visibleDebugResult ? <CodeBlock language="json">{visibleDebugResult}</CodeBlock> : <EmptyState title="尚未发送调试请求" description="点击右上角发送后，响应会显示在这里。" />}
      </Section>
    </ConsolePage>
  );
}
