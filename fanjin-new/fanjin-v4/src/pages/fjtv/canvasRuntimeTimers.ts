export type CanvasTimerRegistry = Record<string, number>;

/** Clear every timer and empty the registry so repeated cleanup is harmless. */
export function clearCanvasTimerRegistry(
  registry: CanvasTimerRegistry,
  clearTimer: (timerId: number) => void,
) {
  Object.keys(registry).forEach((key) => {
    clearTimer(registry[key]);
    delete registry[key];
  });
}
