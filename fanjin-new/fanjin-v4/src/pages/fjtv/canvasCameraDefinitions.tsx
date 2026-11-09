import type { CameraPresetKind, CameraSettings, CameraPresetOption } from "./canvasDataTypes";

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  camera: "panavision-dxl2",
  lens: "arri-signature-prime",
  focalLength: "35mm",
  aperture: "f4",
};

export const CAMERA_PRESETS: Record<CameraPresetKind, CameraPresetOption[]> = {
  camera: [
    { id: "panavision-dxl2", label: "Panavision DXL2", sublabel: "电影机", icon: "camera" },
    { id: "sony-a7r4", label: "Sony A7R IV", sublabel: "全画幅", icon: "camera" },
    { id: "red-komodo", label: "RED Komodo", sublabel: "电影感", icon: "camera" },
  ],
  lens: [
    { id: "arri-signature-prime", label: "Arri Signature Prime", sublabel: "镜头", icon: "lens" },
    { id: "cooke-s4i", label: "Cooke S4/i", sublabel: "镜头", icon: "lens" },
    { id: "zeiss-supreme-prime", label: "Zeiss Supreme Prime", sublabel: "镜头", icon: "lens" },
  ],
  focalLength: [
    { id: "24mm", label: "24", sublabel: "mm", icon: "focalLength", heroText: "24" },
    { id: "35mm", label: "35", sublabel: "mm", icon: "focalLength", heroText: "35" },
    { id: "50mm", label: "50", sublabel: "mm", icon: "focalLength", heroText: "50" },
    { id: "85mm", label: "85", sublabel: "mm", icon: "focalLength", heroText: "85" },
  ],
  aperture: [
    { id: "f14", label: "f/1.4", sublabel: "光圈", icon: "aperture", heroText: "f/1.4" },
    { id: "f28", label: "f/2.8", sublabel: "光圈", icon: "aperture", heroText: "f/2.8" },
    { id: "f4", label: "f/4", sublabel: "光圈", icon: "aperture", heroText: "f/4" },
    { id: "f8", label: "f/8", sublabel: "光圈", icon: "aperture", heroText: "f/8" },
  ],
};

export function findCameraPreset(kind: CameraPresetKind, id: string) {
  return CAMERA_PRESETS[kind].find((item) => item.id === id) ?? CAMERA_PRESETS[kind][0];
}

export function normalizeCameraSettings(input?: Partial<CameraSettings> | null): CameraSettings {
  const next = {
    camera: input?.camera ?? DEFAULT_CAMERA_SETTINGS.camera,
    lens: input?.lens ?? DEFAULT_CAMERA_SETTINGS.lens,
    focalLength: input?.focalLength ?? DEFAULT_CAMERA_SETTINGS.focalLength,
    aperture: input?.aperture ?? DEFAULT_CAMERA_SETTINGS.aperture,
  };
  return {
    camera: findCameraPreset("camera", next.camera).id,
    lens: findCameraPreset("lens", next.lens).id,
    focalLength: findCameraPreset("focalLength", next.focalLength).id,
    aperture: findCameraPreset("aperture", next.aperture).id,
  };
}

export function formatCameraControl(settings: CameraSettings) {
  const focalLength = findCameraPreset("focalLength", settings.focalLength);
  const aperture = findCameraPreset("aperture", settings.aperture);
  return `${findCameraPreset("camera", settings.camera).label} / ${findCameraPreset("lens", settings.lens).label} / ${focalLength.label}${focalLength.sublabel} / ${aperture.label}`;
}
