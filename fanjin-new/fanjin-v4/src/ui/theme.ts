// V4 双主题系统 - 浅色为主,深色可切换
// 读取 localStorage "fanjin-theme" 决定当前主题
import type React from "react";

export type ThemeMode = "light" | "dark";

export type V4Tokens = {
  mode: ThemeMode;
  // 背景
  bg: string;
  bgCard: string;
  bgCardHover: string;
  bgCardActive: string;
  bgSurface: string;
  // 文字
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  // 强调色
  accent: string;
  accentSoft: string;
  accentDeep: string;
  accentInk: string;
  // 状态色
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  // 边框
  border: string;
  borderLight: string;
  divider: string;
  // 玻璃效果
  glass: React.CSSProperties;
  // 间距
  pagePad: number;
  cardPad: number;
  gap: number;
  gapSm: number;
  gapLg: number;
};

const light: V4Tokens = {
  mode: "light",
  bg: "#F4F6F9",
  bgCard: "rgba(255, 255, 255, 0.82)",
  bgCardHover: "rgba(255, 255, 255, 0.92)",
  bgCardActive: "rgba(215, 233, 255, 0.18)",
  bgSurface: "#FFFFFF",
  textPrimary: "#18181B",
  textSecondary: "#71717A",
  textTertiary: "#A1A1AA",
  textInverse: "#FFFFFF",
  accent: "#5D94BD",
  accentSoft: "#D7E9FF",
  accentDeep: "#3B7AA8",
  accentInk: "#FFFFFF",
  success: "#16A34A",
  successBg: "rgba(22, 163, 74, 0.1)",
  warning: "#CA8A04",
  warningBg: "rgba(202, 138, 4, 0.1)",
  danger: "#DC2626",
  dangerBg: "rgba(220, 38, 38, 0.08)",
  border: "#E4E4E7",
  borderLight: "#F4F4F5",
  divider: "rgba(0, 0, 0, 0.06)",
  glass: {
    background: "rgba(255, 255, 255, 0.82)",
    border: "1px solid rgba(0, 0, 0, 0.06)",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.04)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    borderRadius: 28,
  },
  pagePad: 32,
  cardPad: 24,
  gap: 16,
  gapSm: 8,
  gapLg: 24,
};

const dark: V4Tokens = {
  mode: "dark",
  bg: "#050708",
  bgCard: "rgba(229, 238, 245, 0.18)",
  bgCardHover: "rgba(229, 238, 245, 0.24)",
  bgCardActive: "rgba(215, 233, 255, 0.1)",
  bgSurface: "#111719",
  textPrimary: "rgba(255, 255, 255, 0.94)",
  textSecondary: "rgba(255, 255, 255, 0.68)",
  textTertiary: "rgba(255, 255, 255, 0.44)",
  textInverse: "#0B1115",
  accent: "#D7E9FF",
  accentSoft: "#EAF4FF",
  accentDeep: "#8FB7D8",
  accentInk: "#172631",
  success: "#BFE8D1",
  successBg: "rgba(191, 232, 209, 0.1)",
  warning: "#F0D89C",
  warningBg: "rgba(240, 216, 156, 0.1)",
  danger: "#F0A6A6",
  dangerBg: "rgba(240, 166, 166, 0.1)",
  border: "rgba(255, 255, 255, 0.16)",
  borderLight: "rgba(255, 255, 255, 0.08)",
  divider: "rgba(255, 255, 255, 0.08)",
  glass: {
    background: "rgba(229, 238, 245, 0.18)",
    border: "1px solid rgba(255, 255, 255, 0.16)",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 22px 50px rgba(0, 0, 0, 0.16)",
    backdropFilter: "blur(28px)",
    WebkitBackdropFilter: "blur(28px)",
    borderRadius: 28,
  },
  pagePad: 32,
  cardPad: 24,
  gap: 16,
  gapSm: 8,
  gapLg: 24,
};

export const themes = { light, dark } as const;
export const THEME_CHANGE_EVENT = "fanjin-theme-change";

export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("fanjin-theme");
  return saved === "dark" ? "dark" : "light";
}

export function setThemeMode(mode: ThemeMode, remote = false) {
  localStorage.setItem("fanjin-theme", mode);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode, remote } }));
  }
}

export function getTheme(mode?: ThemeMode): V4Tokens {
  return themes[mode ?? getThemeMode()];
}

/** 构造 Glass 卡片样式，可传入 overrides */
export function glassStyle(overrides?: Record<string, string | number>): React.CSSProperties {
  const t = getTheme();
  return { ...t.glass, ...overrides } as React.CSSProperties;
}
