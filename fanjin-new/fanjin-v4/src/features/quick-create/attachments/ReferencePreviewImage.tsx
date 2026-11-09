import { type ImgHTMLAttributes } from "react";
import {
  useAuthenticatedReferenceMedia,
} from "./AuthenticatedReferenceMedia";

export {
  fetchAuthenticatedReferencePreview,
  isAuthenticatedReferencePreviewUrl,
  type ReferencePreviewState,
} from "./AuthenticatedReferenceMedia";

// Render a deterministic local fallback while an authenticated media response
// is loading (or when it is no longer accessible). This value is render-only:
// it is never written into the creation session or the uploaded asset record.
const REFERENCE_PREVIEW_FALLBACK = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="10" fill="#edf2f5"/>
    <path d="M17 18h30v28H17z" fill="none" stroke="#8ca0ad" stroke-width="3"/>
    <circle cx="27" cy="28" r="4" fill="#8ca0ad"/>
    <path d="m20 42 9-9 6 6 4-4 6 7" fill="none" stroke="#8ca0ad" stroke-width="3" stroke-linejoin="round"/>
  </svg>
`)}`;

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
};

/**
 * Native media elements cannot attach the SPA's localStorage Bearer token.
 * Resolve only the protected reference-file route through authenticated fetch,
 * then render a short-lived object URL. The canonical server URL stays in the
 * parent state/session; object URLs are always revoked on replacement/unmount.
 */
export default function ReferencePreviewImage({ src = "", alt = "", ...props }: Props) {
  const preview = useAuthenticatedReferenceMedia(src);

  return (
    <img
      {...props}
      src={preview.url || REFERENCE_PREVIEW_FALLBACK}
      alt={alt}
      data-reference-preview-state={preview.state}
    />
  );
}
