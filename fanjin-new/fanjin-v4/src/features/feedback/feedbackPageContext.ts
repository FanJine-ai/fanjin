import { sanitizeFeedbackPageUrl } from "./feedbackPageUrl";
import { projectModeFromLocation, type ProjectMode } from "../../routes/projectModeRoutes";

export type FeedbackPageContext = {
  pageTitle: string;
  pageUrl: string;
};

type BrowserLocation = Pick<Location, "hash" | "href" | "pathname" | "search">;

const MODE_TITLES: Record<ProjectMode, string> = {
  agent: "Agent \u6a21\u5f0f",
  quick: "\u5feb\u901f\u6a21\u5f0f",
  canvas: "\u753b\u5e03\u6a21\u5f0f",
};

const PAGE_TITLES: Array<readonly [path: string, title: string]> = [
  ["/workbench/create", "\u521b\u4f5c\u9996\u9875"],
  ["/workbench/project", "\u9879\u76ee\u5e7f\u573a"],
  ["/workbench/library", "\u7d20\u6750\u5e93"],
  ["/workbench/assets", "\u8d44\u4ea7\u5e93"],
  ["/workbench/task", "\u4efb\u52a1\u4e2d\u5fc3"],
  ["/workbench/production", "\u751f\u4ea7\u5de5\u4f5c\u53f0"],
  ["/workbench/editor", "\u526a\u8f91\u53f0"],
  ["/workbench/novel", "\u5c0f\u8bf4\u521b\u4f5c"],
  ["/workbench/script", "\u5267\u672c\u521b\u4f5c"],
  ["/workbench/corner-scape", "\u89d2\u666f"],
  ["/workspace", "\u5de5\u4f5c\u53f0\u540e\u53f0"],
  ["/fjadmin", "\u7ba1\u7406\u540e\u53f0"],
  ["/developer", "\u5f00\u53d1\u8005\u4e2d\u5fc3"],
  ["/settings", "\u8bbe\u7f6e"],
  ["/models", "\u6a21\u578b\u5e7f\u573a"],
  ["/docs", "\u5e2e\u52a9\u6587\u6863"],
  ["/fjtv", "\u7e41\u955c\u5e7f\u573a"],
];

function matchesRoute(pathname: string, route: string) {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Reads the app route from both HashRouter URLs and ordinary browser URLs. */
export function feedbackRouteFromLocation(location: BrowserLocation) {
  if (location.hash.startsWith("#/")) {
    const route = new URL(location.hash.slice(1), "https://feedback.local");
    return { pathname: route.pathname, search: route.search };
  }
  return { pathname: location.pathname, search: location.search };
}

export function resolveFeedbackPageTitle(
  location: BrowserLocation,
  fallbackTitle: string,
  pageTitleHint = "",
) {
  const route = feedbackRouteFromLocation(location);
  const mode = projectModeFromLocation(route.pathname, route.search);
  if (mode) return MODE_TITLES[mode];
  if (matchesRoute(route.pathname, "/workbench/canvas")) return MODE_TITLES.canvas;
  if (pageTitleHint.trim()) return pageTitleHint.trim();

  const page = PAGE_TITLES.find(([path]) => matchesRoute(route.pathname, path));
  return page?.[1] || fallbackTitle.trim() || "\u672a\u77e5\u9875\u9762";
}

export function captureFeedbackPageContext(
  location: BrowserLocation,
  fallbackTitle: string,
  pageTitleHint = "",
): FeedbackPageContext {
  return {
    pageTitle: resolveFeedbackPageTitle(location, fallbackTitle, pageTitleHint),
    pageUrl: sanitizeFeedbackPageUrl(location.href),
  };
}
