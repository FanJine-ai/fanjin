import {
type AiModelOption
} from "@/lib/api";
import { useState } from "react";
import type {
ModelCatalogState
} from "./canvasDataTypes";
interface Context {

}
export function useCanvasModelCatalogState({  }: Context) {
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [modelCatalogState, setModelCatalogState] = useState<ModelCatalogState>("loading");
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelCatalogReloadToken, setModelCatalogReloadToken] = useState(0);
  return { models, setModels, modelCatalogState, setModelCatalogState, modelCatalogError, setModelCatalogError, modelCatalogReloadToken, setModelCatalogReloadToken };
}
