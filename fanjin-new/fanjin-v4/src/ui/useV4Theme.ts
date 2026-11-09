import { useState, useCallback, useEffect } from "react";
import { THEME_CHANGE_EVENT, getThemeMode, setThemeMode, getTheme, type ThemeMode, type V4Tokens } from "./theme";

/**
 * V4 主题 hook。返回当前主题 tokens + toggle 函数。
 * 组件消费此 hook 后，主题切换时自动 re-render。
 */
export function useV4Theme(): V4Tokens & { toggle: () => void; setMode: (m: ThemeMode) => void } {
  const [mode, setModeInternal] = useState<ThemeMode>(getThemeMode);

  const setMode = useCallback((m: ThemeMode) => {
    setThemeMode(m);
    setModeInternal(m);
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === "light" ? "dark" : "light");
  }, [mode, setMode]);

  // 监听 storage 事件（跨 tab 同步）
  useEffect(() => {
    const handler = () => setModeInternal(getThemeMode());
    window.addEventListener("storage", handler);
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(THEME_CHANGE_EVENT, handler);
    };
  }, []);

  return { ...getTheme(mode), toggle, setMode };
}
