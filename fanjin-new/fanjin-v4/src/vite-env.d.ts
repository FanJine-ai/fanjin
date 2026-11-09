/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FJTV_GENERATE_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
