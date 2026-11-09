export const ISOLATED_SESSION_PROOF_HASH =
  "#/workbench/create?__proof=isolated-session" as const;

type ProofLocation = Pick<
  Location,
  "hash" | "hostname" | "pathname" | "protocol" | "search"
>;

/**
 * This escape hatch exists only for the runner-owned local Vite proof page.
 * Public builds remain in StrictMode even if a user copies the proof URL.
 */
export function isIsolatedSessionProofPage(
  location: ProofLocation,
  isDevelopmentBuild: boolean,
): boolean {
  if (
    isDevelopmentBuild !== true
    || location.protocol !== "http:"
    || location.hostname !== "127.0.0.1"
    || location.pathname !== "/"
    || location.search !== ""
    || location.hash !== ISOLATED_SESSION_PROOF_HASH
  ) {
    return false;
  }

  const route = new URL(location.hash.slice(1), "http://127.0.0.1");
  const parameters = [...route.searchParams.entries()];
  return route.pathname === "/workbench/create"
    && route.hash === ""
    && parameters.length === 1
    && parameters[0]?.[0] === "__proof"
    && parameters[0]?.[1] === "isolated-session";
}

/**
 * Recurring UI refreshes are product behavior, not part of the isolated CAS
 * mutation proof. Only the exact local development proof suppresses them.
 */
export function shouldInstallRecurringProofPageRefresh(
  location: ProofLocation,
  isDevelopmentBuild: boolean,
): boolean {
  return !isIsolatedSessionProofPage(location, isDevelopmentBuild);
}
