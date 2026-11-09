import * as ONNX_WEB from "onnxruntime-web";
import { pipeline, env as transformersEnv, FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "path";
import fs from "fs";
import type { Knex } from "knex";
import getPath from "@/utils/getPath";

// ── 模型配置 ──
// const modelOnnxFile = ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]; // 模型文件路径
// const modelDtype = "fp16" as const; // 量化类型：fp32
let extractor: FeatureExtractionPipeline | null = null;
let extractorInitPromise: Promise<void> | null = null;

export async function initEmbedding(database?: Knex): Promise<void> {
  if (extractor) return;
  if (extractorInitPromise) return extractorInitPromise;

  extractorInitPromise = initializeEmbedding(database);
  try {
    await extractorInitPromise;
  } finally {
    extractorInitPromise = null;
  }
}

async function initializeEmbedding(database?: Knex): Promise<void> {
  if (extractor) return;

  // Database bootstrap passes its transaction explicitly. Normal runtime
  // callers resolve the singleton lazily, avoiding a db -> migration -> seed
  // -> embedding -> db import cycle.
  const db = database || (await import("@/utils/db")).default;

  // whereIn 返回的是行数组 [{key, value}, ...]，必须按行取 key/value，
  // 不能用 Object.entries(数组)（那会得到 {"0":行,"1":行}，导致配置恒为 undefined）。
  const modelConfigData = await db("o_setting").whereIn("key", ["modelOnnxFile", "modelDtype"]);
  const modelObj: Record<string, string> = {};
  for (const row of modelConfigData as Array<{ key?: string; value?: string }>) {
    if (row?.key != null) modelObj[row.key] = row.value as string;
  }
  let modelOnnxFile = modelObj?.modelOnnxFile ? JSON.parse(modelObj.modelOnnxFile) : ["all-MiniLM-L6-v2", "onnx", "model_fp16.onnx"]; // 模型文件路径
  let modelDtype = modelObj?.modelDtype ?? ("fp16" as const); // 量化类型：fp32
  const onnxPath = path.join(getPath("models"), ...modelOnnxFile);
  if (!fs.existsSync(onnxPath)) {
    throw new Error(`Embedding 模型文件不存在: ${onnxPath}`);
  }

  transformersEnv.allowRemoteModels = false;
  transformersEnv.allowLocalModels = true;
  transformersEnv.localModelPath = getPath("models").replace(/\\/g, "/") + "/";

  const modelFolder = modelOnnxFile[0];
  // @ts-ignore - pipeline 重载联合类型过于复杂
  extractor = await pipeline("feature-extraction", modelFolder, { dtype: modelDtype });
}

export async function getEmbedding(text: string, database?: Knex): Promise<number[]> {
  if (!extractor) await initEmbedding(database);
  const output = await extractor!(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((dot, v, i) => dot + v * b[i], 0);
}

export async function disposeEmbedding(): Promise<void> {
  await extractor?.dispose?.();
  extractor = null;
  extractorInitPromise = null;
}
