import { useCanvasDecisionCleanup } from "./useCanvasGenerationLifecycle";
import { type DraftQuote } from "./CanvasDraftQuoteDialog";
import { type CanvasPricingConfirmation } from "./CanvasPricingConfirmationDialog";
import { useRef, useState } from "react";

export function useCanvasPricingDecisions() {
  const [draftQuote, setDraftQuote] = useState<DraftQuote | null>(null);
  const draftDecisionRef = useRef<((approved: boolean) => void) | null>(null);
  const [pricingConfirmation, setPricingConfirmation] = useState<CanvasPricingConfirmation | null>(null);
  const pricingDecisionRef = useRef<((approved: boolean) => void) | null>(null);
  const pricingConfirmationQueueRef = useRef<Array<{
    confirmation: CanvasPricingConfirmation;
    resolve: (approved: boolean) => void;
  }>>([]);
  const pricingConfirmationActiveRef = useRef(false);
  const showNextPricingConfirmationRef = useRef<() => void>(() => undefined);
  showNextPricingConfirmationRef.current = () => {
    if (pricingConfirmationActiveRef.current) return;
    const next = pricingConfirmationQueueRef.current.shift();
    if (!next) return;
    pricingConfirmationActiveRef.current = true;
    pricingDecisionRef.current = (approved) => {
      pricingDecisionRef.current = null;
      pricingConfirmationActiveRef.current = false;
      setPricingConfirmation(null);
      next.resolve(approved);
      window.setTimeout(() => showNextPricingConfirmationRef.current(), 0);
    };
    setPricingConfirmation(next.confirmation);
  };
  const requestPricingConfirmation = (confirmation: CanvasPricingConfirmation) => new Promise<boolean>((resolve) => {
    pricingConfirmationQueueRef.current.push({ confirmation, resolve });
    showNextPricingConfirmationRef.current();
  });
  const draftSubmittingRef = useRef(new Set<string>());
  useCanvasDecisionCleanup(() => ({ draftDecisionRef, pricingDecisionRef, pricingConfirmationQueueRef, pricingConfirmationActiveRef }), []);

  return {
    draftQuote, setDraftQuote,
    draftDecisionRef, pricingConfirmation,
    setPricingConfirmation, pricingDecisionRef,
    requestPricingConfirmation, draftSubmittingRef,
  };
}
