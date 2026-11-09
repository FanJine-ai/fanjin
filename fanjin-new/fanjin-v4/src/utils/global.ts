export {}
// global.ts — migrated from fanjin-web.
// Vue TDesign MessagePlugin and vue-i18n global references removed.
// This file now provides a lightweight message API stub and a no-op $t.
// Replace with your actual toast/message implementation (e.g. react-hot-toast, antd message).

declare global {
  interface Window {
    $message: {
      success: (msg: string) => void;
      error: (msg: string) => void;
      warning: (msg: string) => void;
      info: (msg: string) => void;
    };
    $port: string;
    $t: (key: string, ...args: unknown[]) => string;
  }
}

const w = window as any;

if (!w.$message) {
  w.$message = {
    success: (msg: string) => console.log("[success]", msg),
    error: (msg: string) => console.error("[error]", msg),
    warning: (msg: string) => console.warn("[warning]", msg),
    info: (msg: string) => console.info("[info]", msg),
  };
}

if (!w.$t) {
  w.$t = (key: string) => key;
}
