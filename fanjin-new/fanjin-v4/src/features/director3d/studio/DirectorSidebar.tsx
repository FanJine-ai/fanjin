"use client";

import {
  Box,
  Camera,
  Circle,
  History,
  Image as ImageIcon,
  Layers3,
  Search,
  Sparkles,
  Upload,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  DirectorCharacterModel,
  DirectorObjectKind,
  DirectorStudioState,
} from "./types";

type SidebarSection = "scene" | "character" | "camera" | "panorama";

interface DirectorSidebarProps {
  studio: DirectorStudioState;
  selectedObjectId: string | null;
  onSelectObject: (objectId: string | null) => void;
  onAddObject: (
    kind: DirectorObjectKind,
    namePrefix?: string,
    characterModel?: DirectorCharacterModel,
  ) => void;
  onAddCamera: (preset: CameraPreset | null) => void;
}

export interface CameraPreset {
  label: string;
  position: [number, number, number];
  fov: number;
}

const cameraPresets: CameraPreset[] = [
  { label: "正面中景", position: [0, 2.2, 7.4], fov: 42 },
  { label: "正面特写", position: [0, 1.8, 3.2], fov: 36 },
  { label: "正面全景", position: [0, 3.4, 11.5], fov: 46 },
  { label: "侧面跟拍", position: [7.2, 2.4, 3.8], fov: 42 },
  { label: "侧面近景", position: [4.1, 1.9, 2.8], fov: 38 },
  { label: "背面中景", position: [0, 2.2, -7.4], fov: 42 },
  { label: "俯拍全景", position: [0, 9.5, 7.8], fov: 48 },
  { label: "45° 横拍", position: [6.4, 3.4, 6.4], fov: 42 },
  { label: "低角度仰拍", position: [0, 0.45, 5.8], fov: 40 },
];

const characterPresets: Array<{
  label: string;
  kind: DirectorObjectKind;
  characterModel?: DirectorCharacterModel;
  disabled?: boolean;
}> = [
  { label: "标准男性", kind: "character", characterModel: "adult-male" },
  { label: "少年", kind: "character", characterModel: "teenager" },
  { label: "标准女性", kind: "character", characterModel: "adult-female" },
  { label: "健硕", kind: "character", characterModel: "muscular" },
  { label: "纤细", kind: "character", characterModel: "slender" },
  { label: "儿童", kind: "character", characterModel: "young-child" },
  { label: "宽厚", kind: "character", characterModel: "broad" },
  { label: "二头身", kind: "character", characterModel: "chibi" },
  { label: "群众（3×3）", kind: "crowd" },
];

export function DirectorSidebar({
  studio,
  selectedObjectId,
  onSelectObject,
  onAddObject,
  onAddCamera,
}: DirectorSidebarProps) {
  const [section, setSection] = useState<SidebarSection>("scene");
  const [search, setSearch] = useState("");
  const sceneObjects = useMemo(
    () =>
      studio.objects.filter((object) =>
        object.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [search, studio.objects],
  );

  const showScene = () => setSection("scene");
  const showCharacters = () => setSection("character");
  const showCameras = () => setSection("camera");
  const showPanorama = () => setSection("panorama");

  return (
    <aside className="grid min-h-0 grid-cols-[64px_minmax(0,1fr)] border-r border-[var(--director-border)] bg-[var(--director-panel)] shadow-[14px_0_32px_rgba(0,0,0,0.06)]">
      <nav className="flex flex-col items-center gap-1 border-r border-[var(--director-border)] bg-[var(--director-panel-alt)] px-2 py-4">
        <SidebarRailButton
          active={section === "scene"}
          label="场景"
          icon={<Layers3 className="h-4 w-4" />}
          onClick={showScene}
        />
        <SidebarRailButton
          active={section === "character"}
          label="添加角色"
          icon={<UserRound className="h-4 w-4" />}
          onClick={showCharacters}
        />
        <SidebarRailButton
          active={section === "camera"}
          label="添加机位"
          icon={<Camera className="h-4 w-4" />}
          onClick={showCameras}
        />
        <SidebarRailButton
          active={section === "panorama"}
          label="全景图"
          icon={<ImageIcon className="h-4 w-4" />}
          onClick={showPanorama}
        />
      </nav>

      <div className="min-h-0 overflow-y-auto bg-[var(--director-panel)] px-4 py-5">
        {section === "scene" && (
          <ScenePanel
            objects={sceneObjects}
            search={search}
            selectedObjectId={selectedObjectId}
            onSearchChange={setSearch}
            onSelectObject={onSelectObject}
          />
        )}
        {section === "character" && (
          <CharacterPanel onAddObject={onAddObject} />
        )}
        {section === "camera" && <CameraPanel onAddCamera={onAddCamera} />}
        {section === "panorama" && <PanoramaPanel />}
      </div>
    </aside>
  );
}

function SidebarRailButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`group relative grid h-11 w-11 place-items-center rounded-xl border transition ${
        active
          ? "border-[var(--director-accent)] bg-[var(--director-accent-soft)] text-[var(--director-accent)] shadow-[0_6px_16px_rgba(99,102,241,0.14)]"
          : "border-transparent text-[var(--director-text-muted)] hover:border-[var(--director-border)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text-secondary)]"
      }`}
    >
      {icon}
      <span className="pointer-events-none absolute -bottom-1 translate-y-full whitespace-nowrap rounded bg-[var(--director-bg)] px-1.5 py-0.5 text-[9px] text-[var(--director-text-muted)] opacity-0 transition group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-5 border-b border-[var(--director-border)] pb-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--director-accent)]">
        导演台工具
      </p>
      <h2 className="mt-1.5 text-base font-semibold tracking-tight text-[var(--director-text)]">
        {children}
      </h2>
    </div>
  );
}

function ScenePanel({
  objects,
  search,
  selectedObjectId,
  onSearchChange,
  onSelectObject,
}: {
  objects: DirectorStudioState["objects"];
  search: string;
  selectedObjectId: string | null;
  onSearchChange: (value: string) => void;
  onSelectObject: (objectId: string) => void;
}) {
  return (
    <>
      <PanelTitle>场景</PanelTitle>
      <label className="relative mb-3 block">
        <span className="sr-only">搜索场景对象</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--director-text-muted)]" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索场景对象"
          className="w-full rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)] py-2.5 pl-9 pr-3 text-xs text-[var(--director-text)] outline-none placeholder:text-[var(--director-text-dim)] transition focus:border-[var(--director-accent)] focus:ring-2 focus:ring-[var(--director-accent-soft)]"
        />
      </label>
      <div className="rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)] p-1.5">
        {objects.map((object) => (
          <SceneItem
            key={object.id}
            active={object.id === selectedObjectId}
            icon={<ObjectKindIcon kind={object.kind} />}
            label={object.name}
            muted={!object.visible}
            onClick={() => onSelectObject(object.id)}
          />
        ))}
      </div>
      {objects.length === 0 && (
        <p className="px-2 py-4 text-xs text-[var(--director-text-dim)]">没有匹配的场景对象</p>
      )}
    </>
  );
}

function SceneItem({
  active,
  icon,
  label,
  muted = false,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-2.5 text-left text-xs transition last:mb-0 ${
        active
          ? "border-[var(--director-accent)] bg-[var(--director-accent-soft)] text-[var(--director-text)]"
          : muted
            ? "border-transparent text-[var(--director-text-dim)] hover:bg-[var(--director-hover)]"
            : "border-transparent text-[var(--director-text-dim)] hover:border-[var(--director-border)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text-secondary)]"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function CharacterPanel({
  onAddObject,
}: {
  onAddObject: (
    kind: DirectorObjectKind,
    namePrefix?: string,
    characterModel?: DirectorCharacterModel,
  ) => void;
}) {
  return (
    <>
      <PanelTitle>添加角色</PanelTitle>
      <p className="mb-3 text-[11px] leading-5 text-[var(--director-text-muted)]">
        选择一个角色预设后，会在场景中心创建可继续编辑的素模。
      </p>
      <div className="space-y-1.5">
        {characterPresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={preset.disabled}
            title={preset.disabled ? "该角色模型待制作" : undefined}
            onClick={() =>
              onAddObject(
                preset.kind,
                undefined,
                preset.characterModel,
              )
            }
            className="group flex w-full items-center gap-2 rounded-xl border border-transparent bg-[var(--director-panel-alt)] px-3 py-2.5 text-left text-xs text-[var(--director-text-secondary)] transition hover:border-[var(--director-border-strong)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text)] disabled:cursor-not-allowed disabled:text-[var(--director-text-dim)] disabled:hover:border-transparent disabled:hover:bg-[var(--director-panel-alt)]"
          >
            {preset.kind === "crowd" ? (
              <UsersRound className="h-3.5 w-3.5 text-[var(--director-text-muted)]" />
            ) : (
              <UserRound className="h-4 w-4 text-[var(--director-accent)] transition group-hover:scale-110" />
            )}
            {preset.label}
          </button>
        ))}
      </div>
      <p className="mb-2 mt-5 text-[11px] font-medium text-[var(--director-text-muted)]">
        几何模型
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        <CompactAddButton
          icon={<Box className="h-3.5 w-3.5" />}
          label="方块"
          onClick={() => onAddObject("cube")}
        />
        <CompactAddButton
          icon={<Circle className="h-3.5 w-3.5" />}
          label="圆球"
          onClick={() => onAddObject("sphere")}
        />
      </div>
    </>
  );
}

function CameraPanel({
  onAddCamera,
}: {
  onAddCamera: (preset: CameraPreset | null) => void;
}) {
  return (
    <>
      <PanelTitle>添加机位</PanelTitle>
      <p className="mb-3 text-[11px] leading-5 text-[var(--director-text-muted)]">
        点击预设会在舞台中创建一个机位并选中它；不会自动切换视角。
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        <CameraPresetButton
          label="当前视角"
          onClick={() => onAddCamera(null)}
        />
        {cameraPresets.map((preset) => (
          <CameraPresetButton
            key={preset.label}
            label={preset.label}
            onClick={() => onAddCamera(preset)}
          />
        ))}
      </div>
    </>
  );
}

function CameraPresetButton({
  label,
  selected = false,
  onClick,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border bg-[var(--director-panel-alt)] px-2 text-xs transition ${
        selected
          ? "border-zinc-100 bg-[var(--director-panel)] text-[var(--director-text)]"
          : "border-[var(--director-border)] text-[var(--director-text-secondary)] hover:border-[var(--director-accent)] hover:bg-[var(--director-hover)]"
      }`}
    >
      <Camera className="h-4 w-4" />
      <span className="text-center leading-4">{label}</span>
    </button>
  );
}

function PanoramaPanel() {
  return (
    <>
      <PanelTitle>全景图</PanelTitle>
      <p className="mb-3 text-[11px] leading-5 text-[var(--director-text-muted)]">
        全景图将作为 3D 场景背景。素材选择和 AI
        生成需要专用的私有全景图渲染链路。
      </p>
      <div className="space-y-2">
        <PanoramaOption
          icon={<Upload className="h-4 w-4" />}
          label="本地上传"
          description="即将接入"
        />
        <PanoramaOption
          icon={<History className="h-4 w-4" />}
          label="历史记录"
          description="即将接入"
        />
        <PanoramaOption
          icon={<Sparkles className="h-4 w-4" />}
          label="AI 生成"
          description="即将接入"
        />
      </div>
    </>
  );
}

function PanoramaOption({
  icon,
  label,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      disabled
      className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--director-border)] bg-[var(--director-panel-alt)] px-3 py-3 text-left text-xs text-[var(--director-text-dim)]"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-[10px] text-[var(--director-text-dim)]">{description}</span>
    </button>
  );
}

function CompactAddButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--director-border)] bg-[var(--director-panel-alt)] px-2 py-2.5 text-[11px] text-[var(--director-text-secondary)] transition hover:border-[var(--director-accent)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text)]"
    >
      {icon}
      {label}
    </button>
  );
}

function ObjectKindIcon({ kind }: { kind: DirectorObjectKind }) {
  if (kind === "camera") return <Camera className="h-3.5 w-3.5" />;
  if (kind === "character") return <UserRound className="h-3.5 w-3.5" />;
  if (kind === "crowd") return <UsersRound className="h-3.5 w-3.5" />;
  if (kind === "sphere") return <Circle className="h-3.5 w-3.5" />;
  return <Box className="h-3.5 w-3.5" />;
}
