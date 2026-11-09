export const PORTRAIT_REGISTRATION_MESSAGE = "正在登记参考素材，通过后自动生成";

export type GenerationPreparation = {
  preparationStage?: "portrait_registration" | null;
  statusMessage?: string | null;
};

export function isPreparingGeneration(task: GenerationPreparation): boolean {
  return task.preparationStage === "portrait_registration";
}

export function generationPreparationMessage(task: GenerationPreparation): string {
  return isPreparingGeneration(task)
    ? task.statusMessage?.trim() || PORTRAIT_REGISTRATION_MESSAGE
    : "";
}

/** Preparation is server-owned and survives a page reload. It has no
 * generation percentage until the provider accepts the generation itself. */
export function generationPreparationPatch(task: GenerationPreparation) {
  const preparing = isPreparingGeneration(task);
  return {
    preparationStage: preparing ? "portrait_registration" as const : undefined,
    statusMessage: preparing ? generationPreparationMessage(task) : undefined,
    ...(preparing ? { generationProgress: 0 } : {}),
  };
}
