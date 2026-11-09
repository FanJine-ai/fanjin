import { CANVAS_ASSET_MANAGER_WIDTH, CANVAS_MIN_REFLOW_WIDTH } from "./canvasAdaptiveLayout";

export function CanvasThemeStyles({ fixedUiZoom }: { fixedUiZoom: number }) {
  const FIXED_UI_ZOOM = fixedUiZoom;
  return (
      <style>{`
        [data-project-theme="dark"] {
          --canvas-overlay-surface: #2a2a2b;
          --canvas-overlay-text: #f7f8fa;
          --canvas-overlay-muted: #aeb7c3;
          --canvas-overlay-border: #434448;
          --canvas-control-surface: #1f2023;
          --canvas-control-text: #f7f8fa;
          --canvas-control-border: #3c3d42;
          --canvas-control-placeholder: #8f939a;
          --canvas-overlay-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
          --canvas-alert-surface: #201b18;
          --canvas-alert-text: #fff7ed;
          --canvas-alert-border: rgba(243, 181, 109, 0.45);
          --text: #f7f8fa;
          --muted: #aeb7c3;
          --line: rgba(255, 255, 255, 0.12);
          --surface-muted: rgba(255, 255, 255, 0.055);
          --control-bg: rgba(255, 255, 255, 0.09);
          --hover: rgba(36, 160, 204, 0.14);
          --active-line: rgba(75, 190, 231, 0.5);
          --accent-strong: #55c7ed;
        }
        [data-project-theme="light"] {
          --canvas-overlay-surface: #ffffff;
          --canvas-overlay-text: #111827;
          --canvas-overlay-muted: #5e6c75;
          --canvas-overlay-border: #d8dee7;
          --canvas-control-surface: #ffffff;
          --canvas-control-text: #111827;
          --canvas-control-border: #cbd5e1;
          --canvas-control-placeholder: #64748b;
          --canvas-overlay-shadow: 0 24px 64px rgba(15, 23, 42, 0.16);
          --canvas-alert-surface: #fff7ed;
          --canvas-alert-text: #7c2d12;
          --canvas-alert-border: #fdba74;
          --text: #111827;
          --muted: #5e6c75;
          --line: rgba(15, 23, 42, 0.14);
          --surface-muted: #f6f8fa;
          --control-bg: #ffffff;
          --hover: rgba(36, 160, 204, 0.1);
          --active-line: rgba(15, 111, 146, 0.44);
          --accent-strong: #0f6f92;
          color: #111111;
        }
        /* Theme attributes also live on the portaled Agent project header.
           Apply the canvas background only to the actual canvas root. */
        [data-testid="infinite-canvas-root"][data-project-theme="light"] {
          background: var(--studio-workspace-bg, #f7f9fb);
        }
        [data-testid="infinite-canvas-root"][data-project-theme="dark"] {
          background: var(--studio-workspace-bg, #171717);
        }
        .canvas-grid-background {
          opacity: 0.72;
        }
        [data-canvas-dialog],
        [data-canvas-popover],
        [data-canvas-toolbar],
        [data-canvas-callout],
        [data-canvas-admission][data-admission-layout="panel"] {
          border-color: var(--canvas-overlay-border) !important;
          background: var(--canvas-overlay-surface) !important;
          color: var(--canvas-overlay-text) !important;
          box-shadow: var(--canvas-overlay-shadow) !important;
        }
        /* Bare ready pill: no card chrome, otherwise light theme paints a white box. */
        [data-canvas-admission]:not([data-admission-layout="panel"]) {
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
          backdrop-filter: none !important;
          padding: 0 !important;
        }
        [data-canvas-surface] {
          border-color: var(--canvas-overlay-border) !important;
          background: var(--surface-muted) !important;
          color: var(--canvas-overlay-text) !important;
        }
        [data-canvas-alert] {
          border-color: var(--canvas-alert-border) !important;
          background: var(--canvas-alert-surface) !important;
          color: var(--canvas-alert-text) !important;
          box-shadow: var(--canvas-overlay-shadow) !important;
        }
        [data-canvas-alert] [class*="text-white"] {
          color: var(--canvas-alert-text) !important;
        }
        [data-canvas-control],
        [data-canvas-dialog] input:not([type="file"]),
        [data-canvas-dialog] select,
        [data-canvas-dialog] textarea {
          border-color: var(--canvas-control-border) !important;
          background: var(--canvas-control-surface) !important;
          color: var(--canvas-control-text) !important;
        }
        [data-canvas-control]::placeholder,
        [data-canvas-dialog] input::placeholder,
        [data-canvas-dialog] textarea::placeholder {
          color: var(--canvas-control-placeholder) !important;
        }
        [data-canvas-info] {
          border-color: var(--canvas-overlay-border) !important;
          background: var(--surface-muted) !important;
          color: var(--canvas-overlay-muted) !important;
        }
        [data-canvas-muted] {
          color: var(--canvas-overlay-muted) !important;
        }
        [data-canvas-link] {
          color: var(--accent-strong) !important;
        }
        [data-canvas-danger] {
          color: var(--canvas-alert-text) !important;
        }
        [data-canvas-divider] {
          border-color: var(--canvas-overlay-border) !important;
        }
        [data-project-theme="light"] [data-canvas-alert] button {
          border-color: var(--canvas-alert-border) !important;
          color: var(--canvas-alert-text) !important;
        }
        [data-project-theme="light"] [data-canvas-alert] button:hover {
          background: var(--surface-muted) !important;
        }
        button[data-canvas-control]:hover {
          background: var(--hover) !important;
        }
        [data-canvas-mode-option] {
          background: transparent !important;
          color: var(--canvas-overlay-muted) !important;
        }
        [data-canvas-mode-option][data-selected="true"] {
          background: var(--canvas-overlay-text) !important;
          color: var(--canvas-overlay-surface) !important;
        }
        [data-canvas-dialog] :focus-visible,
        [data-canvas-popover] :focus-visible,
        [data-canvas-toolbar] :focus-visible {
          outline: 2px solid var(--accent-strong);
          outline-offset: 2px;
        }
        [data-project-theme="light"] [data-canvas-dialog] [data-media-preview],
        [data-project-theme="light"] [data-canvas-dialog] [data-visual-preview] {
          background: #1d1f23 !important;
          color: #f7f8fa !important;
        }
        [data-project-theme="light"] [data-media-preview] .text-white,
        [data-project-theme="light"] [data-media-preview] [class*="text-white/"],
        [data-project-theme="light"] [data-visual-preview] .text-white,
        [data-project-theme="light"] [data-visual-preview] [class*="text-white/"] {
          color: #f7f8fa !important;
        }
        [data-project-theme="light"] [data-canvas-admission][data-admission-layout="panel"] {
          backdrop-filter: blur(18px);
        }
        [data-project-theme="light"] .text-white,
        [data-project-theme="light"] [class~="text-white/78"],
        [data-project-theme="light"] [class~="text-white/80"] {
          color: #111111 !important;
        }
        /* Status chips keep a solid dark surface even in light theme, so their
           labels must stay white. The global text-white flip above would turn
           them into unreadable black-on-black. */
        [data-project-theme="light"] [data-canvas-chip] {
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-canvas-chip] .text-white,
        [data-project-theme="light"] [data-canvas-chip] span,
        [data-project-theme="light"] [data-canvas-chip] button {
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-canvas-dialog] [class*="text-white/"],
        [data-project-theme="light"] [data-canvas-popover] [class*="text-white/"],
        [data-project-theme="light"] [data-canvas-toolbar] [class*="text-white/"] {
          color: var(--canvas-overlay-muted) !important;
        }
        [data-project-theme="light"] [data-canvas-dialog] [data-media-preview] [class*="text-white/"],
        [data-project-theme="light"] [data-canvas-dialog] [data-visual-preview] [class*="text-white/"] {
          color: #f7f8fa !important;
        }
        [data-project-theme="light"] [data-canvas-toolbar] [class~="text-[#a7a7ab]"],
        [data-project-theme="light"] [data-canvas-toolbar] [class~="text-[#9ea2a9]"] {
          color: var(--canvas-overlay-muted) !important;
        }
        [data-project-theme="light"] [class~="text-[#9aa4b4]"],
        [data-project-theme="light"] [class~="text-[#7d8694]"] {
          color: #777f8a !important;
        }
        [data-project-theme="light"] [class*="bg-[#171717]"],
        [data-project-theme="light"] [class*="bg-[#1b1b1b]"],
        [data-project-theme="light"] [class*="bg-[#1a1a1a]"],
        [data-project-theme="light"] [class*="bg-[#202123]"],
        [data-project-theme="light"] [class*="bg-[#222326]"],
        [data-project-theme="light"] [class*="bg-[#222325]"],
        [data-project-theme="light"] [class*="bg-[#242426]"],
        [data-project-theme="light"] [class*="bg-[#282828]"],
        [data-project-theme="light"] [class*="bg-[#2a2a2b]"],
        [data-project-theme="light"] [class*="bg-[#2b2b2d]"],
        [data-project-theme="light"] [class*="bg-[#2c2c2d]"],
        [data-project-theme="light"] [class*="bg-[#2f2f31]"],
        [data-project-theme="light"] [class*="bg-[#3a3a3c]"],
        [data-project-theme="light"] [class*="bg-[#3a3a3d]"],
        [data-project-theme="light"] [class*="bg-[#343434]"] {
          background-color: #f6f6f6 !important;
        }
        [data-project-theme="light"] [class*="bg-[#333438]"] {
          background-color: #e7ebf1 !important;
        }
        [data-project-theme="light"] [class*="border-[#34353a]"],
        [data-project-theme="light"] [class*="border-[#34363b]"],
        [data-project-theme="light"] [class*="border-[#424242]"],
        [data-project-theme="light"] [class*="border-[#434448]"],
        [data-project-theme="light"] [class*="border-[#38393d]"],
        [data-project-theme="light"] [class*="border-[#3a3327]"] {
          border-color: #d8dbe1 !important;
        }
        [data-project-theme="light"] [class~="hover:bg-[#303136]"]:hover,
        [data-project-theme="light"] [class~="hover:bg-[#33291a]"]:hover,
        [data-project-theme="light"] [class~="hover:bg-[#6b6b6d]"]:hover {
          background-color: #eeeeee !important;
        }
        [data-project-theme="light"] [class~="text-[#ffd05f]"],
        [data-project-theme="light"] [class~="text-[#15d2ff]"] {
          color: #00a8cc !important;
        }
        [data-project-theme="light"] [data-canvas-toolbar] [class~="bg-[#3c3d42]"] {
          background-color: var(--canvas-overlay-border) !important;
        }
        [data-project-theme="light"] [data-canvas-toolbar] [class~="hover:bg-[#333336]"]:hover,
        [data-project-theme="light"] [data-canvas-toolbar] [class~="hover:bg-[#343437]"]:hover,
        [data-project-theme="light"] [data-canvas-toolbar] [class~="hover:bg-[#3a3a3d]"]:hover,
        [data-project-theme="light"] [data-canvas-popover] [class~="hover:bg-[#333336]"]:hover,
        [data-project-theme="light"] [data-canvas-popover] [class~="hover:bg-[#343437]"]:hover,
        [data-project-theme="light"] [data-canvas-popover] [class~="hover:bg-[#3a3a3d]"]:hover,
        [data-project-theme="light"] [data-canvas-popover] [class*="hover:bg-white/"]:hover {
          background-color: var(--hover) !important;
        }
        [data-project-theme="light"] [data-canvas-toolbar] button:hover,
        [data-project-theme="light"] [data-canvas-popover] button:hover {
          color: var(--canvas-overlay-text) !important;
        }
        .canvas-topbar-cluster,
        .canvas-asset-button,
        .canvas-zoom-toolbar,
        .canvas-main-toolbar {
          border: 1px solid rgba(255,255,255,0.09);
          background: rgba(36,36,38,0.95);
          color: #f7f8fa;
          box-shadow: 0 14px 34px rgba(0,0,0,0.32);
          backdrop-filter: blur(18px);
        }
        .canvas-topbar-cluster {
          border-radius: 14px;
          padding: 4px;
        }
        .canvas-studio-header {
          position: absolute;
          height: 62px;
          align-items: center;
          border-bottom: 1px solid var(--studio-line, rgba(255,255,255,0.08));
          background: var(--studio-workspace-bg, rgba(23,23,23,0.96));
          padding-top: 0;
          padding-bottom: 0;
          backdrop-filter: blur(18px);
        }
        .canvas-studio-header [data-fanjin-canvas-actions] {
          position: absolute;
          top: 50%;
          left: 50%;
          z-index: 3;
          transform: translate(-50%, -50%);
          transition: left 240ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @media (min-width: ${CANVAS_MIN_REFLOW_WIDTH}px) {
          [data-asset-manager-open="true"] .canvas-studio-header [data-fanjin-canvas-actions] {
            left: calc(50% + ${CANVAS_ASSET_MANAGER_WIDTH / 2}px);
          }
        }
        .canvas-studio-header-actions {
          position: absolute;
          top: 50%;
          right: 12px;
          z-index: 4;
          display: flex;
          align-items: center;
          gap: 5px;
          transform: translateY(-50%);
          color: #dce3ec;
        }
        .canvas-studio-header-actions button,
        .canvas-studio-save-state {
          display: inline-flex;
          min-width: 36px;
          height: 36px;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid transparent;
          border-radius: 9px;
          padding: 0 9px;
          color: inherit;
          font-size: 12px;
          font-weight: 700;
          transition: border-color 160ms ease, background-color 160ms ease, color 160ms ease, transform 160ms ease;
        }
        .canvas-studio-save-state {
          color: #9da6b2;
          white-space: nowrap;
        }
        .canvas-studio-save-state--dirty,
        .canvas-studio-save-state--saving {
          color: #6f91a4;
        }
        .canvas-studio-save-state--error {
          color: #e06c75;
        }
        .canvas-studio-header-actions button:hover:not(:disabled) {
          border-color: rgba(142,213,246,0.24);
          background: rgba(113,196,239,0.12);
          color: #eef7fb;
        }
        .canvas-studio-header-actions button:active:not(:disabled) {
          transform: scale(0.97);
        }
        .canvas-studio-header-actions button:focus-visible {
          outline: 3px solid rgba(142,213,246,0.28);
          outline-offset: 2px;
        }
        .canvas-studio-header-actions button:disabled {
          cursor: not-allowed;
          opacity: 0.42;
        }
        .canvas-studio-share-action {
          border-color: rgba(255,255,255,0.10) !important;
          background: rgba(255,255,255,0.05);
        }
        .canvas-studio-run-action {
          min-width: 74px !important;
          border-color: rgba(142,213,246,0.34) !important;
          background: #d8ecff;
          color: #102033 !important;
        }
        [data-project-theme="light"] .canvas-studio-header-actions {
          color: #536575;
        }
        [data-project-theme="light"] .canvas-studio-save-state {
          color: #526476;
        }
        [data-project-theme="light"] .canvas-studio-save-state--error {
          color: #a92531;
        }
        [data-project-theme="light"] .canvas-studio-share-action {
          border-color: rgba(15,23,42,0.09) !important;
          background: rgba(15,23,42,0.035);
        }
        [data-project-theme="light"] .canvas-studio-header-actions button:hover:not(:disabled) {
          border-color: rgba(0,102,140,0.18);
          background: rgba(14,118,160,0.08);
          color: #0e6d94;
        }
        @media (max-width: 1280px) {
          .canvas-studio-save-state span,
          .canvas-studio-share-action span,
          .canvas-studio-run-action span {
            display: none;
          }
          .canvas-studio-save-state {
            min-width: 36px;
            width: 36px;
            padding: 0;
          }
          .canvas-studio-run-action {
            min-width: 36px !important;
          }
        }
        @media (max-width: 980px) {
          .canvas-studio-header-actions {
            right: 8px;
            gap: 1px;
          }
          .canvas-studio-header-actions button {
            min-width: 32px;
            width: 32px;
            height: 32px;
            padding: 0;
          }
        }
        @media (max-width: 458px) {
          .canvas-studio-header {
            height: 112px;
          }
          .canvas-studio-header [data-fanjin-canvas-actions] {
            top: 82px;
            left: 50%;
            transform: translate(-50%, -50%);
          }
          .canvas-studio-header-actions {
            top: 27px;
            right: 6px;
          }
          .canvas-studio-save-state {
            display: none;
          }
          .canvas-studio-project-header-cluster {
            position: absolute;
            top: 10px;
            left: 6px;
            max-width: calc(100% - 142px);
          }
          .canvas-studio-project-header-cluster .canvas-topbar-cluster {
            min-width: 0;
            overflow: hidden;
          }
          .canvas-studio-project-label {
            display: none;
          }
          .canvas-studio-header .canvas-project-title-button,
          .canvas-studio-project-header-cluster .canvas-project-title-button {
            min-width: 0;
            max-width: 96px;
            padding-right: 4px;
            padding-left: 4px;
          }
          [data-studio-chrome="true"] aside[data-asset-manager] {
            top: 112px !important;
          }
          [data-node-video-settings-menu],
          [data-node-model-menu] {
            max-width: var(--canvas-floating-menu-max-width, calc(100vw - 24px)) !important;
            max-height: calc(100dvh - 136px);
            overflow-y: auto;
            transform: translateX(var(--canvas-floating-menu-shift-x, 0px));
          }
          #canvas-share-popover[data-canvas-popover] {
            left: 12px !important;
            right: 12px !important;
            width: auto !important;
            max-width: var(--canvas-floating-menu-max-width, calc(100vw - 24px)) !important;
            max-height: calc(100dvh - 136px) !important;
            overflow-y: auto;
            transform: translateX(var(--canvas-floating-menu-shift-x, 0px));
          }
        }
        [data-fixed-ui].canvas-studio-header > * {
          zoom: 1;
        }
        .canvas-studio-header .canvas-topbar-cluster,
        .canvas-studio-project-header-cluster .canvas-topbar-cluster {
          gap: 4px;
          border: 0;
          border-radius: 0;
          background: transparent;
          padding: 0;
          box-shadow: none;
          backdrop-filter: none;
        }
        .canvas-studio-project-menu-button {
          height: 34px;
          width: 34px;
          justify-content: center;
          gap: 3px;
          border-radius: 8px;
          padding: 0;
        }
        .canvas-studio-project-label {
          margin-left: 4px;
          color: #8f9299;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
        }
        .canvas-studio-header .canvas-project-title-button,
        .canvas-studio-project-header-cluster .canvas-project-title-button {
          height: 34px;
          max-width: 260px;
          border-radius: 8px;
          padding: 0 8px;
          font-size: 14px;
          font-weight: 650;
        }
        .canvas-studio-project-input {
          height: 34px;
          width: 240px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          background: rgba(255,255,255,0.07);
          padding: 0 9px;
          color: #ffffff;
          font-size: 14px;
          outline: none;
        }
        .canvas-studio-header .canvas-canvas-switcher-button,
        .canvas-studio-project-header-cluster .canvas-canvas-switcher-button {
          height: 32px;
          border-radius: 8px;
          background: rgba(255,255,255,0.07);
          padding: 0 10px;
          font-size: 12px;
        }
        .canvas-project-menu-button,
        .canvas-project-title-button,
        .canvas-canvas-switcher-button,
        .canvas-zoom-tool-button,
        .canvas-main-toolbar-btn {
          color: inherit;
        }
        .canvas-project-menu-button:hover,
        .canvas-project-title-button:hover,
        .canvas-zoom-tool-button:hover,
        .canvas-main-toolbar-btn:hover {
          background: rgba(255,255,255,0.08);
        }
        .canvas-brand-mark {
          display: inline-flex;
          height: 26px;
          width: 26px;
          align-items: center;
          justify-content: center;
          background: transparent;
          color: #ffffff;
          box-shadow: none;
        }
        .canvas-brand-logo-image {
          height: 26px;
          width: 22px;
          display: block;
          color: inherit;
        }
        .canvas-asset-button {
          height: 28px;
          gap: 6px;
          border-radius: 8px;
          padding: 0 6px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0;
        }
        .canvas-zoom-toolbar {
          height: 28px;
          gap: 6px;
          border-radius: 8px;
          padding: 0 5px;
        }
        .canvas-zoom-tool-button {
          height: 24px;
          width: 24px;
          border-radius: 7px;
          color: #cfd6df;
        }
        .canvas-zoom-label {
          min-width: 36px;
          border-radius: 7px;
          padding: 4px 2px;
          color: #f5f7fa;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
        }
        .canvas-main-toolbar {
          gap: 6px;
          border-color: rgba(129,160,190,0.22);
          border-radius: 11px;
          background: rgba(29,49,70,0.94);
          padding: 5px 8px;
          box-shadow: 0 12px 28px rgba(0,0,0,0.32);
        }
        .canvas-main-toolbar-add {
          height: 30px;
          width: 30px;
          border-radius: 8px;
          background: #d8ecff;
          color: #102033;
          box-shadow: none;
        }
        .canvas-main-toolbar-btn {
          height: 28px;
          width: 28px;
          border-radius: 7px;
          color: #c6d4e5;
        }
        @media (min-width: ${CANVAS_MIN_REFLOW_WIDTH}px) {
          [data-asset-manager-open="true"] .canvas-adaptive-header {
            padding-left: ${CANVAS_ASSET_MANAGER_WIDTH + 16}px;
          }
          [data-asset-manager-open="true"] .canvas-adaptive-left {
            left: ${CANVAS_ASSET_MANAGER_WIDTH + 16}px;
          }
          [data-asset-manager-open="true"] .canvas-adaptive-center {
            left: calc(50% + ${CANVAS_ASSET_MANAGER_WIDTH / 2}px);
          }
        }
        [data-project-theme="dark"] .canvas-asset-button,
        [data-project-theme="dark"] .canvas-zoom-toolbar {
          border-color: transparent;
          background: transparent;
          box-shadow: none;
          color: #dce3ec;
          backdrop-filter: none;
        }
        [data-project-theme="light"] .canvas-topbar-cluster,
        [data-project-theme="light"] .canvas-asset-button,
        [data-project-theme="light"] .canvas-zoom-toolbar,
        [data-project-theme="light"] .canvas-main-toolbar {
          border-color: rgba(15,23,42,0.08) !important;
          background: rgba(255,255,255,0.94) !important;
          color: #22303c !important;
          box-shadow: 0 14px 34px rgba(31,45,61,0.11) !important;
        }
        [data-project-theme="light"] .canvas-studio-header {
          border-bottom-color: var(--studio-line, #e4e9ee);
          background: var(--studio-workspace-bg, rgba(250,252,253,0.97));
        }
        [data-project-theme="light"] .canvas-studio-header .canvas-topbar-cluster,
        [data-project-theme="light"] .canvas-studio-project-header-cluster .canvas-topbar-cluster {
          border-color: transparent !important;
          background: transparent !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] .canvas-studio-header .canvas-canvas-switcher-button,
        [data-project-theme="light"] .canvas-studio-project-header-cluster .canvas-canvas-switcher-button {
          border: 1px solid #dfe6eb;
          background: #f3f6f8 !important;
          color: #263642 !important;
          box-shadow: none;
        }
        [data-project-theme="light"] .canvas-studio-header .canvas-canvas-switcher-button svg,
        [data-project-theme="light"] .canvas-studio-project-header-cluster .canvas-canvas-switcher-button svg {
          color: var(--ps-text-200, #313d44);
        }
        [data-project-theme="light"] .canvas-studio-project-label {
          color: #7a8791;
        }
        [data-project-theme="light"] .canvas-studio-project-input {
          border-color: rgba(15,23,42,0.10);
          background: rgba(15,23,42,0.04);
          color: #1f2a36;
        }
        [data-project-theme="light"] .canvas-project-menu-button:hover,
        [data-project-theme="light"] .canvas-project-title-button:hover,
        [data-project-theme="light"] .canvas-canvas-switcher-button:hover,
        [data-project-theme="light"] .canvas-zoom-tool-button:hover,
        [data-project-theme="light"] .canvas-main-toolbar-btn:hover {
          background: rgba(14,118,160,0.08) !important;
        }
        [data-project-theme="light"] .canvas-studio-header .canvas-canvas-switcher-button:hover,
        [data-project-theme="light"] .canvas-studio-project-header-cluster .canvas-canvas-switcher-button:hover {
          border-color: #bfd8e3;
          background: #edf5f8 !important;
          color: #0f6f92 !important;
        }
        [data-project-theme="light"] .canvas-canvas-switcher-button {
          background: #f2f6fb !important;
          color: #1f2a36 !important;
        }
        [data-project-theme="light"] .canvas-brand-mark {
          background: transparent !important;
          color: #050505 !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] .canvas-zoom-tool-button,
        [data-project-theme="light"] .canvas-main-toolbar-btn,
        [data-project-theme="light"] .canvas-zoom-label {
          color: #536273 !important;
        }
        [data-project-theme="light"] .canvas-main-toolbar-add {
          background: #111827 !important;
          color: #ffffff !important;
          box-shadow: 0 8px 18px rgba(17,24,39,0.18) !important;
        }
        [data-project-theme="light"] .canvas-main-toolbar [class*="bg-[#34353a]"],
        [data-project-theme="light"] .canvas-main-toolbar [class*="bg-[#4a4b50]"],
        [data-project-theme="light"] .canvas-zoom-toolbar [class*="bg-[#3f3f42]"] {
          background-color: #e6f5ff !important;
          color: #0879a8 !important;
        }
        .canvas-shortcut-panel {
          width: min(1148px, calc(100vw - 48px));
          border: 1px solid #3b3b3d;
          border-radius: 0 0 10px 10px;
          background: #242424;
          color: #f4f4f5;
          box-shadow: 0 28px 78px rgba(0,0,0,0.46);
        }
        .canvas-shortcut-section {
          min-height: 350px;
          border-right: 1px solid #3b3b3d;
          padding: 0 24px;
        }
        .canvas-shortcut-section:last-child {
          border-right: 0;
        }
        .canvas-shortcut-title {
          margin-bottom: 24px;
          color: #19d6ff;
          font-size: 15px;
          font-weight: 800;
          line-height: 1;
        }
        .canvas-shortcut-row {
          display: flex;
          min-height: 40px;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          color: #9d9d9f;
          font-size: 15px;
        }
        .canvas-shortcut-keys {
          display: inline-flex;
          min-width: 96px;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          color: #f5f5f6;
          font-size: 14px;
          white-space: nowrap;
        }
        .canvas-shortcut-key {
          display: inline-flex;
          min-width: 28px;
          height: 28px;
          align-items: center;
          justify-content: center;
          border: 1px solid #3e3e40;
          border-radius: 8px;
          background: #262628;
          padding: 0 8px;
          color: #f2f2f3;
          line-height: 1;
        }
        .canvas-shortcut-suffix {
          color: #f1f1f2;
        }
        .canvas-shortcut-gesture {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #e7e7e8;
        }
        .canvas-shortcut-gesture svg {
          width: 23px;
          height: 23px;
        }
        .canvas-shortcut-gesture-mark {
          color: #21d8ff;
          font-size: 16px;
          line-height: 1;
        }
        [data-project-theme="light"] [data-material-menu],
        [data-project-theme="light"] [data-project-menu],
        [data-project-theme="light"] [data-canvas-switcher-menu],
        [data-project-theme="light"] [data-menu-panel],
        [data-project-theme="light"] [data-storyboard-slot-menu],
        [data-project-theme="light"] [data-workflow-panel],
        [data-project-theme="light"] [data-history-panel] > div,
        [data-project-theme="light"] [data-asset-panel] > div,
        [data-project-theme="light"] [data-shortcut-panel] {
          border-color: #e5e7eb !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: 0 24px 64px rgba(15, 23, 42, 0.16) !important;
        }
        [data-project-theme="light"] [data-history-panel],
        [data-project-theme="light"] [data-asset-panel] {
          background: rgba(15, 23, 42, 0.18) !important;
        }
        [data-project-theme="light"] [data-material-menu] [class*="text-white"],
        [data-project-theme="light"] [data-project-menu] [class*="text-white"],
        [data-project-theme="light"] [data-canvas-switcher-menu] [class*="text-white"],
        [data-project-theme="light"] [data-menu-panel] [class*="text-white"],
        [data-project-theme="light"] [data-storyboard-slot-menu] [class*="text-white"],
        [data-project-theme="light"] [data-workflow-panel] [class*="text-white"],
        [data-project-theme="light"] [data-history-panel] [class*="text-white"],
        [data-project-theme="light"] [data-asset-panel] [class*="text-white"] {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-material-menu] [class*="text-[#"],
        [data-project-theme="light"] [data-project-menu] [class*="text-[#"],
        [data-project-theme="light"] [data-canvas-switcher-menu] [class*="text-[#"],
        [data-project-theme="light"] [data-menu-panel] [class*="text-[#"],
        [data-project-theme="light"] [data-storyboard-slot-menu] [class*="text-[#"],
        [data-project-theme="light"] [data-workflow-panel] [class*="text-[#"],
        [data-project-theme="light"] [data-history-panel] [class*="text-[#"],
        [data-project-theme="light"] [data-asset-panel] [class*="text-[#"] {
          color: #4b5563 !important;
        }
        [data-project-theme="light"] [data-material-menu] [class*="bg-[#"],
        [data-project-theme="light"] [data-project-menu] [class*="bg-[#"],
        [data-project-theme="light"] [data-canvas-switcher-menu] [class*="bg-[#"],
        [data-project-theme="light"] [data-menu-panel] [class*="bg-[#"],
        [data-project-theme="light"] [data-storyboard-slot-menu] [class*="bg-[#"],
        [data-project-theme="light"] [data-workflow-panel] [class*="bg-[#"],
        [data-project-theme="light"] [data-history-panel] [class*="bg-[#"],
        [data-project-theme="light"] [data-asset-panel] [class*="bg-[#"] {
          background-color: #f3f4f6 !important;
        }
        [data-project-theme="light"] [data-material-menu] button:hover,
        [data-project-theme="light"] [data-project-menu] button:hover,
        [data-project-theme="light"] [data-canvas-switcher-menu] button:hover,
        [data-project-theme="light"] [data-menu-panel] button:hover,
        [data-project-theme="light"] [data-storyboard-slot-menu] button:hover,
        [data-project-theme="light"] [data-workflow-panel] button:hover,
        [data-project-theme="light"] [data-history-panel] button:hover,
        [data-project-theme="light"] [data-asset-panel] button:hover {
          background-color: #eef1f4 !important;
        }
        [data-project-theme="light"] [data-workflow-panel] [style*="linear-gradient"],
        [data-project-theme="light"] [data-asset-panel] [style*="linear-gradient"] {
          background-color: transparent !important;
        }
        [data-project-theme="light"] [data-material-menu],
        [data-project-theme="light"] [data-project-menu],
        [data-project-theme="light"] [data-canvas-switcher-menu],
        [data-project-theme="light"] [data-menu-panel],
        [data-project-theme="light"] [data-storyboard-slot-menu],
        [data-project-theme="light"] [data-workflow-panel],
        [data-project-theme="light"] [data-history-panel] > div,
        [data-project-theme="light"] [data-asset-panel] > div,
        [data-project-theme="light"] [data-shortcut-panel] {
          background: #ffffff !important;
        }
        [data-project-theme="light"] [data-shortcut-panel] {
          border-radius: 0 0 10px 10px;
        }
        [data-project-theme="light"] .canvas-shortcut-section {
          border-right-color: #e5e7eb;
        }
        [data-project-theme="light"] .canvas-shortcut-title,
        [data-project-theme="light"] .canvas-shortcut-row,
        [data-project-theme="light"] .canvas-shortcut-keys,
        [data-project-theme="light"] .canvas-shortcut-suffix,
        [data-project-theme="light"] .canvas-shortcut-gesture,
        [data-project-theme="light"] .canvas-shortcut-gesture-mark {
          color: #111827;
        }
        [data-project-theme="light"] .canvas-shortcut-key {
          border-color: #d1d5db;
          background: #f9fafb;
          color: #111827;
        }
        [data-project-theme="light"] [data-workflow-panel-header] {
          border-bottom-color: #111827 !important;
        }
        [data-project-theme="light"] [data-workflow-panel] [data-workflow-current-tab] {
          border-radius: 999px;
          background: #111827 !important;
          padding: 5px 10px;
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-project-menu] button,
        [data-project-theme="light"] [data-canvas-switcher-menu] button {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-project-menu] svg,
        [data-project-theme="light"] [data-canvas-switcher-menu] svg,
        [data-project-theme="light"] [data-canvas-switcher-menu] span {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-project-menu] [class*="bg-[#4a4a4d]"],
        [data-project-theme="light"] [data-canvas-switcher-menu] [class*="bg-[#333336]"] {
          background-color: #f3f4f6 !important;
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-canvas-switcher-menu] input {
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: inset 0 0 0 1px #d1d5db !important;
        }
        [data-project-theme="light"] [data-node-toolbar],
        [data-project-theme="light"] [data-node-prompt-panel],
        [data-project-theme="light"] [data-node-settings-panel],
        [data-project-theme="light"] [data-node-floating-menu] {
          border-color: #dfe4ea !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: 0 20px 48px rgba(15,23,42,0.14) !important;
        }
        [data-project-theme="light"] [data-node-toolbar] button,
        [data-project-theme="light"] [data-node-prompt-panel] button,
        [data-project-theme="light"] [data-node-settings-panel] button,
        [data-project-theme="light"] [data-node-floating-menu] button {
          color: #334155 !important;
        }
        [data-project-theme="light"] [data-node-toolbar] [class*="text-white"],
        [data-project-theme="light"] [data-node-prompt-panel] [class*="text-white"],
        [data-project-theme="light"] [data-node-settings-panel] [class*="text-white"],
        [data-project-theme="light"] [data-node-floating-menu] [class*="text-white"] {
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-node-toolbar] [class*="text-[#"],
        [data-project-theme="light"] [data-node-prompt-panel] [class*="text-[#"],
        [data-project-theme="light"] [data-node-settings-panel] [class*="text-[#"],
        [data-project-theme="light"] [data-node-floating-menu] [class*="text-[#"] {
          color: #64748b !important;
        }
        [data-project-theme="light"] [data-node-toolbar] [class*="border-white"],
        [data-project-theme="light"] [data-node-toolbar] [class*="border-[#"],
        [data-project-theme="light"] [data-node-prompt-panel] [class*="border-white"],
        [data-project-theme="light"] [data-node-prompt-panel] [class*="border-[#"],
        [data-project-theme="light"] [data-node-settings-panel] [class*="border-white"],
        [data-project-theme="light"] [data-node-settings-panel] [class*="border-[#"],
        [data-project-theme="light"] [data-node-floating-menu] [class*="border-white"],
        [data-project-theme="light"] [data-node-floating-menu] [class*="border-[#"] {
          border-color: #d8dee7 !important;
        }
        [data-project-theme="light"] [data-node-video-settings-menu] button[data-selected="true"] {
          border-color: #334155 !important;
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-node-toolbar] button[class*=" bg-[#"],
        [data-project-theme="light"] [data-node-toolbar] button[class^="bg-[#"],
        [data-project-theme="light"] [data-node-toolbar] button[class*=" bg-white/"],
        [data-project-theme="light"] [data-node-toolbar] button[class^="bg-white/"],
        [data-project-theme="light"] [data-node-prompt-panel] button[class*=" bg-[#"],
        [data-project-theme="light"] [data-node-prompt-panel] button[class^="bg-[#"],
        [data-project-theme="light"] [data-node-prompt-panel] button[class*=" bg-white/"],
        [data-project-theme="light"] [data-node-prompt-panel] button[class^="bg-white/"],
        [data-project-theme="light"] [data-node-settings-panel] button[class*=" bg-[#"],
        [data-project-theme="light"] [data-node-settings-panel] button[class^="bg-[#"],
        [data-project-theme="light"] [data-node-floating-menu] button[class*=" bg-[#"],
        [data-project-theme="light"] [data-node-floating-menu] button[class^="bg-[#"],
        [data-project-theme="light"] [data-node-floating-menu] button[class*=" bg-white/"],
        [data-project-theme="light"] [data-node-floating-menu] button[class^="bg-white/"] {
          background: #edf6fb !important;
          color: #0f6f92 !important;
        }
        [data-project-theme="light"] [data-node-toolbar] button:hover,
        [data-project-theme="light"] [data-node-prompt-panel] button:hover,
        [data-project-theme="light"] [data-node-settings-panel] button:hover,
        [data-project-theme="light"] [data-node-floating-menu] button:hover {
          background-color: #eef3f7 !important;
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-node-floating-menu] [data-canvas-alert] {
          border-color: var(--canvas-alert-border) !important;
          background: var(--canvas-alert-surface) !important;
          color: var(--canvas-alert-text) !important;
        }
        [data-project-theme="light"] [data-node-toolbar] button:disabled,
        [data-project-theme="light"] [data-node-prompt-panel] button:disabled,
        [data-project-theme="light"] [data-node-settings-panel] button:disabled,
        [data-project-theme="light"] [data-node-floating-menu] button:disabled {
          color: #9ca3af !important;
        }
        [data-project-theme="light"] [data-node-toolbar] [class*="w-px"],
        [data-project-theme="light"] [data-node-toolbar] [class*="h-px"] {
          background-color: #e5e7eb !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] [data-prompt-preview] {
          color: #374151 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] [data-prompt-reference-capsule] {
          border-color: #bae6fd !important;
          background: #e0f2fe !important;
          color: #075985 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] [data-prompt-reference-badge],
        [data-project-theme="light"] [data-node-toolbar] [data-node-toolbar-badge] {
          background: #0ea5c6 !important;
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] textarea,
        [data-project-theme="light"] [data-node-prompt-panel] input {
          caret-color: #111827 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] textarea:not(.text-transparent) {
          color: #111827 !important;
          -webkit-text-fill-color: #111827 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] textarea::placeholder,
        [data-project-theme="light"] [data-node-prompt-panel] input::placeholder {
          color: #94a3b8 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-generate-button] {
          background: #111827 !important;
          color: #ffffff !important;
          box-shadow: 0 8px 18px rgba(17,24,39,0.18) !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-generate-button]:hover {
          background: #263449 !important;
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-generate-button] svg {
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] {
          border-color: #d9e2ea !important;
          background: #ffffff !important;
          color: #1f2a36 !important;
          box-shadow: 0 20px 48px rgba(31,45,61,0.13) !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-chip] {
          border: 1px solid #dbe5ed !important;
          background: #f4f7fa !important;
          color: #415466 !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-model-control] {
          color: #34495a !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"] {
          border-color: #7e8c9b !important;
          background: #f1f5f8 !important;
          color: #30495a !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"] svg,
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"] span {
          color: #30495a !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:hover {
          border-color: #6f7d8b !important;
          background: #e9f0f5 !important;
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:hover svg,
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:hover span {
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:active {
          border-color: #5f6d7b !important;
          background: #e1eaf0 !important;
        }
        [data-project-theme="dark"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:hover {
          border-color: #81909f !important;
          background: #3d3d40 !important;
        }
        [data-project-theme="dark"] [data-audio-prompt-panel] [data-audio-voice-control][data-selected="true"]:active {
          border-color: #94a3b8 !important;
          background: #444448 !important;
        }
        [data-audio-prompt-panel] [data-audio-voice-control]:focus-visible {
          outline: 3px solid #2f90b6;
          outline-offset: 2px;
        }
        [data-project-theme="light"] [data-node-model-menu] {
          border-color: #d9e1e8 !important;
          background: #fbfdff !important;
          box-shadow: 0 22px 52px rgba(15,23,42,0.16) !important;
        }
        [data-project-theme="light"] [data-node-model-menu] button[data-node-model-item] {
          min-height: 58px;
          border: 1px solid transparent !important;
          background: transparent !important;
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-node-model-menu] button[data-node-model-item]:hover {
          border-color: #e2e8f0 !important;
          background: #f1f5f9 !important;
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-node-model-menu] button[data-node-model-item][data-selected="true"] {
          border-color: #bae0ef !important;
          background: #eaf6fb !important;
          color: #0f5f7a !important;
          box-shadow: inset 3px 0 0 #2f90b6 !important;
        }
        [data-project-theme="light"] [data-node-model-icon] {
          background: #eef2f6 !important;
          color: #526273 !important;
        }
        [data-project-theme="light"] [data-node-model-item][data-selected="true"] [data-node-model-icon] {
          background: #d9eef6 !important;
          color: #167494 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-reference-trigger] {
          border-color: #d7e0e8 !important;
          background: #f8fafc !important;
          color: #475569 !important;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04) !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-reference-trigger]:hover {
          border-color: #a9d5e5 !important;
          background: #edf8fc !important;
          color: #0f6f92 !important;
          transform: translateY(-1px);
          box-shadow: 0 5px 14px rgba(47,144,182,0.10) !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-reference-thumbnail] {
          border-color: #ffffff !important;
          background: #f8fafc !important;
          box-shadow: 0 0 0 1px #cfd9e3, 0 3px 10px rgba(15,23,42,0.08) !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-reference-thumbnail]:hover {
          border-color: #ffffff !important;
          box-shadow: 0 0 0 2px #8fc9dd, 0 5px 14px rgba(47,144,182,0.14) !important;
        }
        [data-project-theme="light"] [data-node-video-tabs] {
          gap: 6px;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-video-tab] {
          display: inline-flex;
          min-height: 36px;
          align-items: center;
          gap: 6px;
          border-color: #d7e0e8 !important;
          background: #ffffff !important;
          color: #526273 !important;
          font-weight: 600;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-video-tab][data-enabled="true"]:hover {
          border-color: #afd8e7 !important;
          background: #f2f9fc !important;
          color: #0f6f92 !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-video-tab][data-selected="true"] {
          border-color: #9bcfe1 !important;
          background: #e7f5fa !important;
          color: #0d6d8d !important;
          box-shadow: inset 0 0 0 1px rgba(47,144,182,0.08) !important;
        }
        [data-project-theme="light"] [data-node-prompt-panel] button[data-node-video-tab][data-enabled="false"] {
          cursor: not-allowed;
          border-color: #e5e7eb !important;
          background: #f8fafc !important;
          color: #94a3b8 !important;
        }
        [data-project-theme="light"] [data-node-video-tab-requirement] {
          border-radius: 999px;
          background: #e9eef3;
          padding: 1px 5px;
          color: #7b8794;
          font-size: 9px;
          font-weight: 600;
          line-height: 1.4;
        }
        [data-project-theme="light"] [data-node-prompt-panel] [data-node-video-tab-tooltip] {
          border-color: rgba(255,255,255,0.12) !important;
          background: #111827 !important;
          color: #f8fafc !important;
        }
        [data-project-theme="light"] [data-node-camera-overlay] {
          background: rgba(15,23,42,0.32) !important;
          backdrop-filter: blur(2px);
        }
        [data-project-theme="light"] [data-node-camera-panel] {
          border-color: #d9e1e8 !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: 0 28px 70px rgba(15,23,42,0.22) !important;
        }
        [data-project-theme="light"] [data-node-camera-panel] [class*="border-[#"] {
          border-color: #e5e7eb !important;
        }
        [data-project-theme="light"] [data-node-camera-panel] [class*="text-white"] {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-node-camera-panel] [class*="text-[#"] {
          color: #64748b !important;
        }
        [data-project-theme="light"] [data-node-camera-card] {
          border-color: #d7e0e8 !important;
          background: #f7f9fb !important;
          color: #334155 !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 5px 14px rgba(15,23,42,0.05) !important;
        }
        [data-project-theme="light"] [data-node-camera-card] [style*="radial-gradient"],
        [data-project-theme="light"] [data-node-camera-card] [class*="bg-[radial-gradient"] {
          border-color: #aebdca !important;
          background: radial-gradient(circle at center,#dbe5ec 0%,#eef3f7 68%,#d8e1e8 100%) !important;
          color: #526273 !important;
        }
        [data-project-theme="light"] [data-node-camera-control] {
          border: 1px solid #e2e8f0;
          background: #ffffff !important;
          color: #64748b !important;
        }
        [data-project-theme="light"] [data-node-camera-control]:hover {
          border-color: #b9dce8 !important;
          background: #edf8fc !important;
          color: #0f6f92 !important;
        }
        [data-project-theme="light"] [data-node-camera-apply] {
          background: #111827 !important;
          color: #ffffff !important;
          box-shadow: 0 8px 18px rgba(17,24,39,0.18) !important;
        }
        [data-project-theme="light"] [data-node-camera-apply]:hover {
          background: #263449 !important;
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-node-card] {
          border-color: #d8dbe1 !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: 0 18px 46px rgba(15,23,42,0.08);
        }
        [data-project-theme="light"] [data-node-surface] [class*="bg-[#2"],
        [data-project-theme="light"] [data-node-surface] [class*="bg-[#3"] {
          background-color: #f8fafc !important;
        }
        [data-project-theme="light"] [data-node-surface] [class*="text-white"] {
          color: #1f2937 !important;
        }
        [data-project-theme="light"] [data-node-surface] [class*="text-[#"] {
          color: #64748b !important;
        }
        [data-project-theme="light"] [data-node-surface] [class*="border-[#"] {
          border-color: #d8dee7 !important;
        }
        [data-project-theme="light"] [data-node-surface] button:hover {
          color: #0f6f92 !important;
        }
        [data-project-theme="light"] [data-product-script-node],
        [data-project-theme="light"] [data-product-script-skeleton],
        [data-project-theme="light"] [data-product-script-progress-chip] {
          border-color: #e5e7eb !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.72), 0 18px 46px rgba(15,23,42,0.08) !important;
        }
        [data-project-theme="light"] [data-product-script-node] [class*="text-white"],
        [data-project-theme="light"] [data-product-script-skeleton] [class*="text-white"],
        [data-project-theme="light"] [data-product-script-progress-chip] [class*="text-white"] {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-product-script-node] [class*="text-[#"],
        [data-project-theme="light"] [data-product-script-skeleton] [class*="text-[#"],
        [data-project-theme="light"] [data-product-script-progress-chip] [class*="text-[#"] {
          color: #4b5563 !important;
        }
        [data-project-theme="light"] [data-product-script-node] [class*="bg-black"],
        [data-project-theme="light"] [data-product-script-node] [class*="bg-[#"],
        [data-project-theme="light"] [data-product-script-skeleton] [class*="bg-[#"] {
          background-color: #f3f4f6 !important;
        }
        [data-project-theme="light"] [data-product-script-node] [class*="border-white"],
        [data-project-theme="light"] [data-product-script-skeleton] [class*="border-white"] {
          border-color: #d1d5db !important;
        }
        [data-project-theme="light"] [data-product-script-node] .bg-white,
        [data-project-theme="light"] [data-product-script-skeleton] .bg-white {
          background-color: #111827 !important;
          color: #ffffff !important;
        }
        [data-project-theme="light"] [data-menu-panel] svg,
        [data-project-theme="light"] [data-menu-panel] span,
        [data-project-theme="light"] [data-storyboard-slot-menu] svg,
        [data-project-theme="light"] [data-storyboard-slot-menu] span {
          color: #111827 !important;
        }
        [data-project-theme="light"] [data-menu-panel] button:disabled,
        [data-project-theme="light"] [data-menu-panel] button:disabled span,
        [data-project-theme="light"] [data-menu-panel] button:disabled svg {
          color: #9ca3af !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] {
          border-right-color: #e2e8ed !important;
          background: #f8fafb !important;
          color: #273743 !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-shell] {
          background: #f8fafb !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-header],
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-tabs],
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-footer] {
          border-color: #e4e9ee !important;
          background: #fbfcfd !important;
        }
        [data-minimap-node] {
          transition: filter 0.12s ease;
        }
        [data-minimap-node]:hover {
          filter: brightness(1.4);
        }
        [data-project-theme="light"] [data-minimap-node]:hover {
          filter: brightness(0.82);
        }
        [data-minimap-viewport] {
          pointer-events: none;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-studio-minimap] > div:first-child {
          border-color: var(--studio-line, #dbe3ec) !important;
          background: var(--studio-muted-bg, #f2f5f8) !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-studio-minimap] > div:last-child {
          border-color: var(--studio-line, #dbe3ec) !important;
          background: var(--studio-workspace-bg, #f7f9fb) !important;
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-studio-minimap] button:hover {
          background: #e7f3fb !important;
          color: #0e6d94 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-brand],
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-breadcrumbs],
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-breadcrumbs] button {
          color: #1f2d3d !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-brand-mark] {
          background: #172033 !important;
          color: #ffffff !important;
          box-shadow: 0 2px 7px rgba(15,23,42,0.16);
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-close] {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-close]:hover {
          background: #edf2f7 !important;
          color: #243241 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-tabs] button[data-selected="false"] {
          background: transparent !important;
          color: #687985 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-tabs] button[data-selected="false"]:hover {
          background: #f0f4f8 !important;
          color: #243241 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-tabs] button[data-selected="true"] {
          border-color: #d8e4ea !important;
          background: #ffffff !important;
          color: #0e6d94 !important;
          box-shadow: 0 1px 2px rgba(28,45,56,0.05) !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-tabs] button:not([data-selected]) {
          color: #607286 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-section-head] {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-section-head] [class*="text-[#"] {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-section-head] button {
          border-color: #d9e2eb !important;
          background: #f7f9fc !important;
          color: #34495e !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-section-head] button:hover {
          border-color: #bed8e6 !important;
          background: #edf7fb !important;
          color: #0e6d94 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-search] {
          border-color: #dde5ea !important;
          background: #ffffff !important;
          color: #60717d !important;
          box-shadow: none;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-search]:focus-within {
          border-color: #9fcfe2 !important;
          background: #ffffff !important;
          box-shadow: 0 0 0 3px rgba(47,144,182,0.10);
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-search] input {
          color: #243241 !important;
          caret-color: #0e6d94;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-search] input::placeholder {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-content] {
          background: #f8fafb !important;
          color: #526476 !important;
          color-scheme: light;
          scrollbar-color: #cbd5df transparent;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-empty] {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-group] {
          border-color: #e1e7ee !important;
          background: #f6f8fb !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-group-title],
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-group-title] svg {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node] {
          border-color: transparent !important;
          background: transparent !important;
          color: #243241 !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node]:hover {
          border-color: #e2e8ed !important;
          background: #f1f5f7 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node][data-active="true"] {
          border-color: #c9dde6 !important;
          background: #edf5f8 !important;
          box-shadow: none !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-thumbnail],
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-asset-thumbnail] {
          border-color: #d7e0e9 !important;
          background: #eef2f6 !important;
          color: #66788a !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-thumbnail] [class*="text-[#"] {
          color: #66788a !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-title] {
          color: #243241 !important;
          font-weight: 500;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-more] {
          color: #718096 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-more]:hover {
          background: #dceaf2 !important;
          color: #0e6d94 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node] input {
          border-color: #9fcfe2 !important;
          background: #ffffff !important;
          color: #243241 !important;
          box-shadow: 0 0 0 3px rgba(47,144,182,0.10);
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-menu] {
          border-color: #dce3eb !important;
          background: #ffffff !important;
          box-shadow: 0 16px 36px rgba(15,23,42,0.16) !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-menu] button {
          background: transparent !important;
          color: #243241 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-canvas-sidebar-node-menu] button:hover {
          background: #eef3f7 !important;
          color: #0e6d94 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-asset-item] {
          color: #243241 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-asset-item]:hover {
          background: #f0f4f8 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-asset-item] [class*="text-white"] {
          color: #243241 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-asset-item] [class*="text-[#"] {
          color: #526476 !important;
        }
        [data-project-theme="light"] aside[data-asset-manager] [data-asset-manager-footer] {
          color: #526476 !important;
        }
        [data-menu-panel],
        [data-workflow-panel],
        [data-asset-panel],
        [data-history-panel],
        [data-shortcut-panel],
        [data-asset-manager],
        [data-storyboard-slot-menu],
        [data-fixed-ui] {
          overscroll-behavior: contain;
        }
        @media (prefers-reduced-motion: reduce) {
          .canvas-studio-header [data-fanjin-canvas-actions],
          .canvas-studio-header-actions button,
          .canvas-project-menu-button,
          .canvas-project-title-button,
          .canvas-canvas-switcher-button {
            transition-duration: 0.01ms !important;
          }
        }
        @media (hover: none) {
          [data-history-hover-actions],
          [data-workflow-card-action] {
            pointer-events: auto !important;
            opacity: 1 !important;
          }
        }
        [data-fixed-ui] > *,
        [data-bottom-shell],
        [data-top-shell]:not(header) {
          zoom: ${FIXED_UI_ZOOM};
        }
      `}</style>
  );
}
