export function CanvasAnimationStyles() {
  return <style>{`
    @keyframes canvas-edge-comet-breathe {
      0%, 100% { opacity: 0.72; }
      50% { opacity: 1; }
    }
    @keyframes canvas-edge-pulse {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }
    @keyframes node-upload-soft-breathe {
      0%, 100% { opacity: 0.72; }
      50% { opacity: 0.48; }
    }
  `}</style>;
}
