export const CANVAS_ACCOUNT_MENU_ITEMS = [
  { label: "个人中心", key: "user" },
  { label: "订阅与开发票", key: "subscription" },
  { label: "模式切换", key: "mode" },
  { label: "退出登录", key: "logout" },
] as const;

export type CanvasAccountMenuKey = typeof CANVAS_ACCOUNT_MENU_ITEMS[number]["key"];
