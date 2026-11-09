import {
  firstActiveModel,
  type DeveloperCatalog,
  type DeveloperEndpointType,
} from "./useDeveloperCatalog";

type PlaceholderEntry = {
  placeholder: string;
  endpointTypes: readonly DeveloperEndpointType[];
  fallback: string;
};

const PLACEHOLDER_TABLE: PlaceholderEntry[] = [
  { placeholder: "deepseek-v3", endpointTypes: ["text"], fallback: "YOUR_TEXT_MODEL_ID" },
  { placeholder: "flux-1-dev", endpointTypes: ["image_generation"], fallback: "YOUR_IMAGE_MODEL_ID" },
  { placeholder: "doubao-seedance-2-0-fast-260128", endpointTypes: ["video_generation"], fallback: "YOUR_VIDEO_MODEL_ID" },
  { placeholder: "tts-1", endpointTypes: ["tts"], fallback: "YOUR_TTS_MODEL_ID" },
  { placeholder: "text-embedding-3-small", endpointTypes: ["embedding"], fallback: "YOUR_TEXT_EMBEDDING_MODEL_ID" },
  { placeholder: "doubao-embedding-vision-251215", endpointTypes: ["multimodal_embedding"], fallback: "YOUR_MULTIMODAL_EMBEDDING_MODEL_ID" },
];

/** Replace static example IDs with models callable in the current workspace. Atomic single-pass to prevent cross-contamination. */
export function resolveDeveloperDocModelExamples(
  content: string,
  catalog: DeveloperCatalog,
) {
  const replacementMap = new Map<string, string>();
  for (const entry of PLACEHOLDER_TABLE) {
    replacementMap.set(
      entry.placeholder,
      firstActiveModel(catalog, entry.endpointTypes) || entry.fallback,
    );
  }

  const pattern = new RegExp(
    PLACEHOLDER_TABLE.map((e) => e.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );

  return content.replace(pattern, (match) => replacementMap.get(match) ?? match);
}
