export const stableJson = (v: any): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
