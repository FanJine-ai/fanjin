export function createApiAndMediaProxy(target: string) {
  const route = () => ({
    target,
    changeOrigin: true,
  });

  return {
    "/api": route(),
    "/v1": { ...route(), ws: true },
    "/v1beta": route(),
    "/oss": route(),
  };
}
