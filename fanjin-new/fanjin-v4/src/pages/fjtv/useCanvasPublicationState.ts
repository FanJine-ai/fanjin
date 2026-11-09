import { useRef, useState } from "react";
import { type CanvasShareRecord, type FjtvPublicationRecord } from "@/lib/api";

export function useCanvasPublicationState() {
  const [canvasShares, setCanvasShares] = useState<CanvasShareRecord[]>([]);
  const [fjtvPublications, setFjtvPublications] = useState<FjtvPublicationRecord[]>([]);
  const [canvasPublicationLoading, setCanvasPublicationLoading] = useState(false);
  const [canvasPublicationBusy, setCanvasPublicationBusy] = useState<"share" | "fjtv" | "revoke" | null>(null);
  const [canvasPublicationError, setCanvasPublicationError] = useState<string | null>(null);
  const canvasPublicationAttemptRef = useRef<Record<"share" | "fjtv", { scope: string; key: string } | null>>({ share: null, fjtv: null });
  return {
    canvasShares, setCanvasShares,
    fjtvPublications, setFjtvPublications,
    canvasPublicationLoading, setCanvasPublicationLoading,
    canvasPublicationBusy, setCanvasPublicationBusy,
    canvasPublicationError, setCanvasPublicationError,
    canvasPublicationAttemptRef,
  };
}
