"use client";

import { Quaternion, Vector3 } from "three";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type {
  DirectorViewOrientation,
  DirectorViewPreset,
} from "./DirectorScenePreview";

export interface ViewCompassHandle {
  updateOrientation: (orientation: DirectorViewOrientation) => void;
}

export const ViewCompass = forwardRef<
  ViewCompassHandle,
  { onSelect: (preset: DirectorViewPreset) => void }
>(function ViewCompass({ onSelect }, ref) {
  const [orientation, setOrientation] = useState<DirectorViewOrientation>([
    0,
    0,
    0,
    1,
  ]);
  const updateOrientation = useCallback(
    (nextOrientation: DirectorViewOrientation) => {
      setOrientation((currentOrientation) =>
        currentOrientation.every(
          (value, index) => Math.abs(value - nextOrientation[index]) < 0.0001,
        )
          ? currentOrientation
          : nextOrientation,
      );
    },
    [],
  );
  useImperativeHandle(ref, () => ({ updateOrientation }), [updateOrientation]);
  const compass = useMemo(
    () => getCompassProjection(orientation),
    [orientation],
  );

  return (
    <div className="absolute right-5 top-5 z-10 h-28 w-20">
      <span className="sr-only">三维视角坐标轴控件</span>
      <div className="relative h-20 w-20 rounded-full bg-[#1f2025] shadow-[inset_0_1px_rgba(255,255,255,0.04)]">
        <svg
          viewBox="0 0 120 120"
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {compass.lines.map((line) => (
            <path
              key={line.preset}
              d={`M60 60 L${line.x.toFixed(2)} ${line.y.toFixed(2)}`}
              stroke={line.depth < 0 ? "#4b4e58" : line.color}
              strokeWidth="2.3"
              strokeOpacity={line.depth < 0 ? 0.62 : 0.94}
              strokeLinecap="round"
            />
          ))}
          <circle cx="60" cy="60" r="3" fill="#58606f" />
        </svg>
        {compass.points.map((point) => (
          <AxisOrb
            key={point.preset}
            point={point}
            onClick={() => onSelect(point.preset)}
          />
        ))}
      </div>
      <button
        type="button"
        title="重置为默认导演视角"
        aria-label="重置为默认导演视角"
        onClick={() => onSelect("reset")}
        className="absolute left-1/2 top-[76px] h-5 -translate-x-1/2 rounded bg-[#35363d] px-2 text-[10px] font-medium text-[var(--director-text-secondary)] transition hover:bg-[#484a53] hover:text-white"
      >
        重置视角
      </button>
    </div>
  );
});

function AxisOrb({
  point,
  onClick,
}: {
  point: CompassPoint;
  onClick: () => void;
}) {
  const colorClass = {
    red: "border-red-300/75 bg-[radial-gradient(circle_at_35%_26%,#ffb3b7_0_7%,#ef5560_19%,#bd1928_62%,#59070f_100%)] shadow-[0_0_7px_rgba(245,61,73,0.55)]",
    green:
      "border-emerald-200/75 bg-[radial-gradient(circle_at_35%_26%,#9af0b7_0_7%,#3dca76_19%,#13894a_62%,#062816_100%)] shadow-[0_0_7px_rgba(46,210,111,0.52)]",
    blue: "border-blue-200/75 bg-[radial-gradient(circle_at_35%_26%,#a7c4ff_0_7%,#4d88f0_19%,#1a57c6_62%,#081b4e_100%)] shadow-[0_0_7px_rgba(68,132,255,0.55)]",
  }[point.color];
  const backPointClass =
    "border-zinc-500 bg-[#50535c] shadow-none hover:border-zinc-300 hover:bg-[#646872]";

  return (
    <button
      type="button"
      title={point.title}
      aria-label={point.title}
      onClick={onClick}
      style={{
        left: `${(point.x * 2) / 3}px`,
        top: `${(point.y * 2) / 3}px`,
        zIndex: point.depth < 0 ? 10 : 20,
      }}
      className={`absolute grid h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border transition hover:scale-125 ${point.depth < 0 ? backPointClass : colorClass}`}
    >
      <span className="sr-only">{point.label}</span>
    </button>
  );
}

type CompassColor = "red" | "green" | "blue";

interface CompassPoint {
  color: CompassColor;
  depth: number;
  label: string;
  preset: DirectorViewPreset;
  title: string;
  x: number;
  y: number;
}

function getCompassProjection(orientation: DirectorViewOrientation) {
  const cameraInverse = new Quaternion(...orientation).invert();
  const axes: Array<{
    color: CompassColor;
    label: string;
    preset: DirectorViewPreset;
    title: string;
    vector: [number, number, number];
  }> = [
    {
      color: "red",
      label: "X+",
      preset: "x-positive",
      title: "右视（X+）",
      vector: [1, 0, 0],
    },
    {
      color: "red",
      label: "X−",
      preset: "x-negative",
      title: "左视（X−）",
      vector: [-1, 0, 0],
    },
    {
      color: "green",
      label: "Y+",
      preset: "y-positive",
      title: "俯视（Y+）",
      vector: [0, 1, 0],
    },
    {
      color: "green",
      label: "Y−",
      preset: "y-negative",
      title: "仰视（Y−）",
      vector: [0, -1, 0],
    },
    {
      color: "blue",
      label: "Z+",
      preset: "z-positive",
      title: "前视（Z+）",
      vector: [0, 0, 1],
    },
    {
      color: "blue",
      label: "Z−",
      preset: "z-negative",
      title: "后视（Z−）",
      vector: [0, 0, -1],
    },
  ];
  const projected = axes.map((axis) => {
    const point = new Vector3(...axis.vector).applyQuaternion(cameraInverse);
    return {
      ...axis,
      depth: point.z,
      x: 60 + point.x * 39,
      y: 60 - point.y * 39,
    };
  });

  return {
    lines: [...projected].sort((a, b) => a.depth - b.depth),
    points: [...projected].sort((a, b) => a.depth - b.depth),
  };
}
