import {
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithRef,
} from "react";
import { readApiSettings } from "../../../api/http";

const REFERENCE_PREVIEW_PATH = "/api/assets/getReferenceFile";
const REFERENCE_VIDEO_FALLBACK = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="10" fill="#edf2f5"/>
    <rect x="14" y="18" width="36" height="28" rx="4" fill="none" stroke="#8ca0ad" stroke-width="3"/>
    <path d="m28 26 11 6-11 6z" fill="#8ca0ad"/>
  </svg>
`)}`;

export type ReferencePreviewState = "direct" | "loading" | "ready" | "error";

export type AuthenticatedReferenceMediaSource = {
  url: string;
  state: ReferencePreviewState;
};

function parsedReferencePreviewUrl(source: string): URL | null {
  const normalized = source.trim();
  if (!normalized || /^(?:blob|data):/iu.test(normalized)) return null;
  try {
    const parsed = new URL(normalized, window.location.origin);
    return parsed.pathname === REFERENCE_PREVIEW_PATH ? parsed : null;
  } catch {
    return null;
  }
}

export function isAuthenticatedReferencePreviewUrl(source: string): boolean {
  return parsedReferencePreviewUrl(source) !== null;
}

function referencePreviewRequestUrl(source: string, apiBaseUrl: string): string {
  const parsed = parsedReferencePreviewUrl(source);
  if (!parsed) return source;
  const normalizedBase = apiBaseUrl.replace(/\/+$/u, "");
  const apiRelativePath = `${parsed.pathname.slice("/api".length)}${parsed.search}`;
  return `${normalizedBase}${apiRelativePath}`;
}

export async function fetchAuthenticatedReferencePreview(
  source: string,
  options: {
    signal?: AbortSignal;
    apiBaseUrl?: string;
    token?: string;
  } = {},
): Promise<Blob> {
  const settings = readApiSettings();
  const apiBaseUrl = options.apiBaseUrl ?? settings.baseUrl;
  const token = (options.token ?? settings.token).trim();
  const response = await fetch(referencePreviewRequestUrl(source, apiBaseUrl), {
    method: "GET",
    credentials: "same-origin",
    signal: options.signal,
    headers: token ? { Authorization: token } : {},
  });
  if (!response.ok) {
    throw new Error(`素材预览读取失败：${response.status}`);
  }
  return response.blob();
}

/**
 * Resolve the protected reference-file endpoint to a component-local object
 * URL. Native image/video/audio elements cannot attach the SPA Bearer token.
 * The returned blob URL is render-only and is revoked whenever source, API
 * settings, or component lifetime changes.
 */
export function useAuthenticatedReferenceMedia(source: string): AuthenticatedReferenceMediaSource {
  const protectedPreview = useMemo(() => isAuthenticatedReferencePreviewUrl(source), [source]);
  const settings = protectedPreview
    ? readApiSettings()
    : { baseUrl: "", token: "" };
  const [preview, setPreview] = useState<AuthenticatedReferenceMediaSource>(() => (
    protectedPreview
      ? { url: "", state: "loading" }
      : { url: source, state: "direct" }
  ));

  useEffect(() => {
    if (!protectedPreview) {
      setPreview({ url: source, state: "direct" });
      return undefined;
    }

    const controller = new AbortController();
    let objectUrl = "";
    let alive = true;
    setPreview({ url: "", state: "loading" });
    void fetchAuthenticatedReferencePreview(source, {
      signal: controller.signal,
      apiBaseUrl: settings.baseUrl,
      token: settings.token,
    }).then((blob) => {
      if (!alive) return;
      objectUrl = window.URL.createObjectURL(blob);
      setPreview({ url: objectUrl, state: "ready" });
    }).catch((error) => {
      if (!alive || controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return;
      setPreview({ url: "", state: "error" });
    });

    return () => {
      alive = false;
      controller.abort();
      if (objectUrl) window.URL.revokeObjectURL(objectUrl);
    };
  }, [protectedPreview, settings.baseUrl, settings.token, source]);

  return preview;
}

type VideoProps = Omit<ComponentPropsWithRef<"video">, "src"> & {
  src?: string;
  fallbackPoster?: string;
};

export function ReferencePreviewVideo({
  src = "",
  fallbackPoster = REFERENCE_VIDEO_FALLBACK,
  preload = "metadata",
  playsInline = true,
  ...props
}: VideoProps) {
  const preview = useAuthenticatedReferenceMedia(src);
  return (
    <video
      {...props}
      src={preview.url || undefined}
      poster={preview.url ? props.poster : fallbackPoster || props.poster}
      preload={preload}
      playsInline={playsInline}
      data-reference-preview-state={preview.state}
    />
  );
}

type AudioProps = Omit<ComponentPropsWithRef<"audio">, "src"> & {
  src?: string;
};

export function ReferencePreviewAudio({ src = "", preload = "metadata", ...props }: AudioProps) {
  const preview = useAuthenticatedReferenceMedia(src);
  return (
    <audio
      {...props}
      src={preview.url || undefined}
      preload={preload}
      data-reference-preview-state={preview.state}
    />
  );
}
