// Feedback needs a reproducible route, never session, payment, or invitation tokens.
export function sanitizeFeedbackPageUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid page URL");
  const safeSearch = (search: string) => {
    const mode = new URLSearchParams(search).get("mode");
    return mode && ["agent", "quick", "quick_create", "canvas"].includes(mode)
      ? `?mode=${mode}` : "";
  };
  url.username = "";
  url.password = "";
  url.search = safeSearch(url.search);
  if (url.hash.startsWith("#/")) {
    const route = new URL(url.hash.slice(1), "https://feedback.local");
    url.hash = `#${route.pathname}${safeSearch(route.search)}`;
  } else url.hash = "";
  return url.toString();
}
