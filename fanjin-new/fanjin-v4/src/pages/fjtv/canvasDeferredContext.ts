// Preserve per-property reads while controllers are wired before state hooks.
export function createCanvasDeferredContext<T extends object>(readers: {
  [K in keyof T]: () => T[K];
}): T {
  const descriptors = Object.fromEntries(
    Object.entries(readers).map(([key, read]) => [
      key,
      { get: read as () => unknown, enumerable: true },
    ]),
  );
  return Object.defineProperties({}, descriptors) as T;
}
