/**
 * Mail links carry only a non-authorizing locator. Secrets are accepted only
 * through an HttpOnly initiating-browser cookie or an explicitly entered
 * email security code.
 */
export function readAuthHandoffLocator(
  searchParams?: URLSearchParams | null,
  href?: string,
): string {
  const fromHashRoute = String(searchParams?.get("handoff") || "").trim();
  if (fromHashRoute) return fromHashRoute;
  const source = href ?? (typeof window === "undefined" ? "" : window.location.href);
  if (!source) return "";
  try {
    return String(new URL(source).searchParams.get("handoff") || "").trim();
  } catch {
    return "";
  }
}

/** Replace the current history entry with the same route minus the locator. */
export function scrubAuthHandoffLocator(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("handoff");
    const hashIndex = url.hash.indexOf("?");
    if (hashIndex >= 0) {
      const route = url.hash.slice(0, hashIndex);
      const params = new URLSearchParams(url.hash.slice(hashIndex + 1));
      params.delete("handoff");
      const query = params.toString();
      url.hash = query ? `${route}?${query}` : route;
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A malformed URL fails closed; no credential is copied elsewhere.
  }
}
