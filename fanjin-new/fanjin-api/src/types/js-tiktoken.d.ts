// js-tiktoken exposes rank files through package exports. The API currently
// uses TypeScript's legacy node resolution; mirror only this export's type.
declare module "js-tiktoken/ranks/o200k_base" {
  const ranks: ConstructorParameters<typeof import("js-tiktoken/lite").Tiktoken>[0];
  export default ranks;
}
