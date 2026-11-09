import { IMAGE_NINE_GRID_MENU_ITEMS } from "./canvasMediaMenuConfig";
import { Aperture, Clock3, Film, LayoutGrid, Layers3, Store, Workflow } from "lucide-react";

export function buildGridCellKey(row: number, col: number) {
  return `${row}:${col}`;
}

export function parseGridCellKey(key: string) {
  const [row, col] = String(key || "0:0").split(":").map((value) => Number.parseInt(value, 10) || 0);
  return { row, col };
}

export function buildGridCellLabel(row: number, col: number) {
  return `${row + 1}-${col + 1}`;
}

export function buildGridPresetLabel(rows: number, cols: number) {
  return `${rows * cols}宫格 (${rows}x${cols})`;
}

export function renderNineGridMenuIcon(kind: (typeof IMAGE_NINE_GRID_MENU_ITEMS)[number]["icon"]) {
  if (kind === "portrait") return <Aperture className="h-4 w-4" />;
  if (kind === "person") return <Workflow className="h-4 w-4" />;
  if (kind === "scene") return <Layers3 className="h-4 w-4" />;
  if (kind === "product") return <Store className="h-4 w-4" />;
  if (kind === "film") return <Film className="h-4 w-4" />;
  if (kind === "time") return <Clock3 className="h-4 w-4" />;
  return <LayoutGrid className="h-4 w-4" />;
}
