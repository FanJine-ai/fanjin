import type { PricingModel } from "../../features/pricing/types";

import alibabaCloudLogo from "@lobehub/icons-static-svg/icons/alibabacloud-color.svg";
import anthropicLogo from "@lobehub/icons-static-svg/icons/anthropic.svg";
import azureLogo from "@lobehub/icons-static-svg/icons/azure-color.svg";
import baichuanLogo from "@lobehub/icons-static-svg/icons/baichuan-color.svg";
import baiduLogo from "@lobehub/icons-static-svg/icons/baidu-color.svg";
import bedrockLogo from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import byteDanceLogo from "@lobehub/icons-static-svg/icons/bytedance-color.svg";
import chatGlmLogo from "@lobehub/icons-static-svg/icons/chatglm-color.svg";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import cohereLogo from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepSeekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import doubaoLogo from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import falLogo from "@lobehub/icons-static-svg/icons/fal-color.svg";
import fishAudioLogo from "@lobehub/icons-static-svg/icons/fishaudio.svg";
import fluxLogo from "@lobehub/icons-static-svg/icons/flux.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import googleLogo from "@lobehub/icons-static-svg/icons/google-color.svg";
import groqLogo from "@lobehub/icons-static-svg/icons/groq.svg";
import huggingFaceLogo from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import hunyuanLogo from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import ideogramLogo from "@lobehub/icons-static-svg/icons/ideogram.svg";
import klingLogo from "@lobehub/icons-static-svg/icons/kling-color.svg";
import metaLogo from "@lobehub/icons-static-svg/icons/meta-color.svg";
import midjourneyLogo from "@lobehub/icons-static-svg/icons/midjourney.svg";
import minimaxLogo from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshotLogo from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nvidiaLogo from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import ollamaLogo from "@lobehub/icons-static-svg/icons/ollama.svg";
import openAiLogo from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterLogo from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import perplexityLogo from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import pikaLogo from "@lobehub/icons-static-svg/icons/pika.svg";
import pixVerseLogo from "@lobehub/icons-static-svg/icons/pixverse-color.svg";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import recraftLogo from "@lobehub/icons-static-svg/icons/recraft.svg";
import replicateLogo from "@lobehub/icons-static-svg/icons/replicate.svg";
import runwayLogo from "@lobehub/icons-static-svg/icons/runway.svg";
import senseNovaLogo from "@lobehub/icons-static-svg/icons/sensenova-color.svg";
import siliconCloudLogo from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg";
import sparkLogo from "@lobehub/icons-static-svg/icons/spark-color.svg";
import stabilityLogo from "@lobehub/icons-static-svg/icons/stability-color.svg";
import stepFunLogo from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import sunoLogo from "@lobehub/icons-static-svg/icons/suno.svg";
import togetherLogo from "@lobehub/icons-static-svg/icons/together-color.svg";
import vertexAiLogo from "@lobehub/icons-static-svg/icons/vertexai-color.svg";
import viduLogo from "@lobehub/icons-static-svg/icons/vidu-color.svg";
import volcengineLogo from "@lobehub/icons-static-svg/icons/volcengine-color.svg";
import xAiLogo from "@lobehub/icons-static-svg/icons/xai.svg";
import yiLogo from "@lobehub/icons-static-svg/icons/yi-color.svg";

export type ModelLogoAsset = {
  src: string;
  label: string;
};

type LogoRule = ModelLogoAsset & {
  keywords: string[];
};

// NewAPI renders its model/vendor marks from LobeHub Icons. Keep model-family
// rules ahead of provider fallbacks so a routed DeepSeek or GLM model retains
// its own identity even when the serving vendor is Volcano or another gateway.
const logoRules: LogoRule[] = [
  { src: openAiLogo, label: "OpenAI", keywords: ["openai", "chatgpt", "gpt-", "gpt ", "o1-", "o3-", "o4-", "dall-e", "whisper", "sora"] },
  { src: claudeLogo, label: "Claude", keywords: ["claude"] },
  { src: anthropicLogo, label: "Anthropic", keywords: ["anthropic"] },
  { src: geminiLogo, label: "Google Gemini", keywords: ["gemini", "gemma"] },
  { src: googleLogo, label: "Google", keywords: ["google"] },
  { src: deepSeekLogo, label: "DeepSeek", keywords: ["deepseek"] },
  { src: qwenLogo, label: "Qwen", keywords: ["qwen", "tongyi", "通义"] },
  { src: chatGlmLogo, label: "ChatGLM", keywords: ["chatglm", "glm-", "glm ", "zhipu", "智谱"] },
  { src: doubaoLogo, label: "Doubao", keywords: ["doubao", "豆包", "seedream", "seedance", "seed-1", "seed-2", "jimeng", "即梦"] },
  { src: metaLogo, label: "Meta", keywords: ["llama", "meta"] },
  { src: fluxLogo, label: "FLUX", keywords: ["flux", "black forest", "blackforest", "bfl"] },
  { src: mistralLogo, label: "Mistral AI", keywords: ["mistral", "mixtral", "codestral"] },
  { src: xAiLogo, label: "xAI", keywords: ["grok", "xai", "x.ai"] },
  { src: moonshotLogo, label: "Moonshot AI", keywords: ["moonshot", "kimi"] },
  { src: minimaxLogo, label: "MiniMax", keywords: ["minimax", "hailuo", "海螺"] },
  { src: cohereLogo, label: "Cohere", keywords: ["cohere", "command-r", "command r"] },
  { src: stabilityLogo, label: "Stability AI", keywords: ["stability", "stable diffusion", "stable-diffusion", "sdxl"] },
  { src: midjourneyLogo, label: "Midjourney", keywords: ["midjourney", "mid journey"] },
  { src: runwayLogo, label: "Runway", keywords: ["runway", "gen-3", "gen-4"] },
  { src: klingLogo, label: "Kling AI", keywords: ["kling", "可灵", "kuaishou", "快手"] },
  { src: hunyuanLogo, label: "Tencent Hunyuan", keywords: ["hunyuan", "混元", "tencent"] },
  { src: baiduLogo, label: "Baidu", keywords: ["ernie", "wenxin", "文心", "baidu"] },
  { src: sparkLogo, label: "iFlytek Spark", keywords: ["讯飞", "iflytek", "sparkdesk", "spark-"] },
  { src: yiLogo, label: "01.AI", keywords: ["01.ai", "zeroone", "yi-large", "yi-lightning", "yi-"] },
  { src: siliconCloudLogo, label: "SiliconCloud", keywords: ["siliconcloud", "siliconflow", "硅基流动"] },
  { src: togetherLogo, label: "Together AI", keywords: ["together ai", "together-"] },
  { src: perplexityLogo, label: "Perplexity", keywords: ["perplexity", "sonar-"] },
  { src: groqLogo, label: "Groq", keywords: ["groq"] },
  { src: openRouterLogo, label: "OpenRouter", keywords: ["openrouter"] },
  { src: azureLogo, label: "Microsoft Azure", keywords: ["azure", "microsoft"] },
  { src: bedrockLogo, label: "Amazon Bedrock", keywords: ["bedrock", "amazon", "aws"] },
  { src: vertexAiLogo, label: "Google Vertex AI", keywords: ["vertex ai", "vertexai", "google cloud"] },
  { src: falLogo, label: "fal", keywords: ["fal.ai", "fal-ai", "fal "] },
  { src: replicateLogo, label: "Replicate", keywords: ["replicate"] },
  { src: huggingFaceLogo, label: "Hugging Face", keywords: ["hugging face", "huggingface"] },
  { src: nvidiaLogo, label: "NVIDIA", keywords: ["nvidia", "nemotron"] },
  { src: ollamaLogo, label: "Ollama", keywords: ["ollama"] },
  { src: stepFunLogo, label: "StepFun", keywords: ["stepfun", "step-", "阶跃星辰"] },
  { src: baichuanLogo, label: "Baichuan", keywords: ["baichuan", "百川"] },
  { src: senseNovaLogo, label: "SenseNova", keywords: ["sensenova", "sensetime", "商汤"] },
  { src: fishAudioLogo, label: "Fish Audio", keywords: ["fishaudio", "fish audio"] },
  { src: sunoLogo, label: "Suno", keywords: ["suno"] },
  { src: viduLogo, label: "Vidu", keywords: ["vidu"] },
  { src: pixVerseLogo, label: "PixVerse", keywords: ["pixverse"] },
  { src: pikaLogo, label: "Pika", keywords: ["pika"] },
  { src: ideogramLogo, label: "Ideogram", keywords: ["ideogram"] },
  { src: recraftLogo, label: "Recraft", keywords: ["recraft"] },
  { src: alibabaCloudLogo, label: "Alibaba Cloud", keywords: ["alibaba", "aliyun", "阿里云", "bailian", "百炼"] },
  { src: byteDanceLogo, label: "ByteDance", keywords: ["bytedance", "字节跳动"] },
  { src: volcengineLogo, label: "Volcengine", keywords: ["volcano", "volcengine", "火山引擎"] },
];

function normalizedIdentity(...parts: Array<string | undefined | null>) {
  return parts.filter(Boolean).join(" ").trim().toLowerCase();
}

function resolveFromIdentity(identity: string): ModelLogoAsset | null {
  if (!identity) return null;
  const matched = logoRules.find((rule) => rule.keywords.some((keyword) => identity.includes(keyword)));
  return matched ? { src: matched.src, label: matched.label } : null;
}

export function resolveModelLogoAsset(model: PricingModel): ModelLogoAsset | null {
  const modelMatch = resolveFromIdentity(normalizedIdentity(model.model_name, model.name));
  if (modelMatch) return modelMatch;
  return resolveFromIdentity(normalizedIdentity(model.vendor_name, model.vendor_icon));
}

export function resolveVendorLogoAsset(vendorName?: string | null): ModelLogoAsset | null {
  return resolveFromIdentity(normalizedIdentity(vendorName));
}
