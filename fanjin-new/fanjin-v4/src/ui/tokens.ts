// V4 Design Tokens - 暗色石墨底 + 冰蓝高光 + 雾面玻璃
// 参考：docs/ui-redesign-v4/01-design-system.md

export const V4 = {
  // 背景
  bg: "#050708",
  bgGraphite: "#111719",
  bgMist: "#667069",
  bgPanel: "rgba(229, 238, 245, 0.18)",
  bgPanelStrong: "rgba(24, 28, 29, 0.72)",
  bgPanelHover: "rgba(229, 238, 245, 0.24)",

  // 冰蓝强调
  accent: "#D7E9FF",
  accentSoft: "#EAF4FF",
  accentDeep: "#8FB7D8",
  accentInk: "#172631",

  // 文字
  textPrimary: "rgba(255, 255, 255, 0.94)",
  textSecondary: "rgba(255, 255, 255, 0.68)",
  textTertiary: "rgba(255, 255, 255, 0.44)",
  textInverse: "#0B1115",

  // 状态色
  success: "#BFE8D1",
  warning: "#F0D89C",
  danger: "#F0A6A6",
  info: "#D7E9FF",

  // 玻璃效果
  glass: {
    background: "rgba(229, 238, 245, 0.18)",
    border: "1px solid rgba(255, 255, 255, 0.16)",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 22px 50px rgba(0, 0, 0, 0.16)",
    backdropFilter: "blur(28px)",
    WebkitBackdropFilter: "blur(28px)",
    borderRadius: 28,
  },

  // 强调玻璃（更不透明）
  glassStrong: {
    background: "rgba(24, 28, 29, 0.72)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.1),  0 22px 50px rgba(0, 0, 0, 0.24)",
    backdropFilter: "blur(28px)",
    WebkitBackdropFilter: "blur(28px)",
    borderRadius: 28,
  },

  // 半透明分割线
  divider: "rgba(255, 255, 255, 0.08)",
  dividerLight: "rgba(255, 255, 255, 0.16)",

  // 间距
  pagePad: 32,
  cardPad: 24,
  gap: 16,
  gapSm: 8,
  gapLg: 24,
} as const;
