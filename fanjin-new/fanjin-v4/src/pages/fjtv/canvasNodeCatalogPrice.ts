type CatalogEntry = { id: string; type: string; [key: string]: unknown };

export function getNodeCatalogPrice<T extends { type: string; model?: string | null }, C extends CatalogEntry>(node: T, models: readonly C[], getModelType: (type: T["type"]) => string, getPrice: (model: C | undefined) => number | null): number | null {
  const modelType = getModelType(node.type);
  return getPrice(models.find((item) => item.id === node.model && item.type === modelType));
}
