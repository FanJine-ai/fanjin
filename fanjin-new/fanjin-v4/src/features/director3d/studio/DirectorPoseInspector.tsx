"use client";

import { DecimalNumberInput } from "./DecimalNumberInput";
import type { DirectorPoseAdjustments, DirectorPosePreset } from "./types";

const POSE_PRESETS = [
  { label: "站立", value: "standing" },
  { label: "T型", value: "t-pose" },
  { label: "行走", value: "walking" },
  { label: "跑步", value: "running" },
  { label: "坐姿", value: "sitting" },
  { label: "蹲下", value: "crouching" },
  { label: "单膝跪", value: "kneeling-one" },
  { label: "双膝跪", value: "kneeling-both" },
  { label: "叉腰", value: "hands-on-hips" },
  { label: "倚靠", value: "leaning" },
  { label: "鞠躬", value: "bowing" },
  { label: "思考", value: "thinking" },
  { label: "格斗", value: "fighting" },
  { label: "踢球", value: "kicking" },
  { label: "投掷", value: "throwing" },
  { label: "推进", value: "pushing" },
  { label: "招手", value: "waving" },
  { label: "伸手", value: "stretching" },
  { label: "抱臂", value: "arms-crossed" },
  { label: "看手机", value: "phone" },
] as const satisfies ReadonlyArray<{
  label: string;
  value: DirectorPosePreset;
}>;

interface PoseControl {
  key: keyof DirectorPoseAdjustments;
  label: string;
  min: number;
  max: number;
}

const POSE_ADJUSTMENT_GROUPS: Array<{
  label: string;
  controls: PoseControl[];
}> = [
  {
    label: "身体",
    controls: [
      { key: "bodyPitch", label: "前倾", min: -90, max: 90 },
      { key: "bodyTurn", label: "转身", min: -90, max: 90 },
      { key: "bodyRoll", label: "侧倾", min: -45, max: 45 },
    ],
  },
  {
    label: "躯干",
    controls: [
      { key: "torsoPitch", label: "前倾", min: -45, max: 45 },
      { key: "torsoTwist", label: "扭转", min: -45, max: 45 },
      { key: "torsoRoll", label: "侧倾", min: -30, max: 30 },
    ],
  },
  {
    label: "头部",
    controls: [
      { key: "headNod", label: "点头", min: -60, max: 60 },
      { key: "headTurn", label: "转头", min: -90, max: 90 },
      { key: "headTilt", label: "歪头", min: -30, max: 30 },
    ],
  },
];

interface LimbPoseControl {
  key: keyof DirectorPoseAdjustments;
  label: string;
  min: number;
  max: number;
}

const LIMB_POSE_GROUPS: Array<{
  label: string;
  sides: Array<{ label: string; controls: LimbPoseControl[] }>;
}> = [
  {
    label: "手臂—肩",
    sides: [
      {
        label: "左",
        controls: [
          { key: "leftShoulderForward", label: "前举", min: -90, max: 180 },
          { key: "leftShoulderOut", label: "外展", min: -10, max: 90 },
          { key: "leftShoulderTwist", label: "扭转", min: -90, max: 90 },
        ],
      },
      {
        label: "右",
        controls: [
          { key: "rightShoulderForward", label: "前举", min: -90, max: 180 },
          { key: "rightShoulderOut", label: "外展", min: -10, max: 90 },
          { key: "rightShoulderTwist", label: "扭转", min: -90, max: 90 },
        ],
      },
    ],
  },
  {
    label: "肘部",
    sides: [
      {
        label: "左",
        controls: [{ key: "leftElbowBend", label: "弯曲", min: 0, max: 150 }],
      },
      {
        label: "右",
        controls: [{ key: "rightElbowBend", label: "弯曲", min: 0, max: 150 }],
      },
    ],
  },
  {
    label: "腿部—髋",
    sides: [
      {
        label: "左",
        controls: [
          { key: "leftHipForward", label: "前抬", min: -90, max: 120 },
          { key: "leftHipOut", label: "外展", min: -30, max: 60 },
          { key: "leftHipTwist", label: "扭转", min: -45, max: 45 },
        ],
      },
      {
        label: "右",
        controls: [
          { key: "rightHipForward", label: "前抬", min: -90, max: 120 },
          { key: "rightHipOut", label: "外展", min: -30, max: 60 },
          { key: "rightHipTwist", label: "扭转", min: -45, max: 45 },
        ],
      },
    ],
  },
  {
    label: "膝部",
    sides: [
      {
        label: "左",
        controls: [{ key: "leftKneeBend", label: "弯曲", min: 0, max: 150 }],
      },
      {
        label: "右",
        controls: [{ key: "rightKneeBend", label: "弯曲", min: 0, max: 150 }],
      },
    ],
  },
];

const POSE_DESCRIPTIONS: Record<DirectorPosePreset, string> = {
  standing: "当前以模型默认站立姿势为基准，可继续调整全身骨骼。",
  "t-pose": "T型已应用到角色的躯干、左右上臂和前臂骨骼。",
  walking: "行走已应用骨盆、躯干、头部和左右镜像的四肢参数。",
  running: "跑步已应用身体重心、对侧摆臂与大步幅四肢参数。",
  sitting: "坐姿将双髋与双膝弯曲到坐下角度，双臂自然收起。",
  crouching: "蹲下同时压低骨盆、弯曲双腿并使躯干前倾。",
  "kneeling-one": "单膝跪以一侧腿支撑，另一侧膝盖向地面收拢。",
  "kneeling-both": "双膝跪将双膝同时弯曲，保持上身相对直立。",
  "hands-on-hips": "叉腰将双肘弯曲并将手臂收向腰侧。",
  leaning: "倚靠通过身体侧倾、躯干扭转和单腿弯曲形成支撑感。",
  bowing: "鞠躬主要前倾躯干与头部，四肢保持自然约束。",
  thinking: "思考将右手收到面部，配合轻微转头与躯干扭转。",
  fighting: "格斗以防守抱架、屈膝和身体转向形成战斗预备姿势。",
  kicking: "踢球抬起右腿并用双臂与躯干平衡身体重心。",
  throwing: "投掷将右臂抬高后屈，同时扭转躯干并错开双腿。",
  pushing: "推进将双臂向前伸出，以前后步与前倾躯干提供力量。",
  waving: "招手抬起右上臂与前臂，头部向手势方向轻微转动。",
  stretching: "伸手将双臂向上前方展开，上身随之伸展。",
  "arms-crossed": "抱臂将左右前臂同时收到胸前交叉。",
  phone: "看手机将双手收到身前，并使头部低下看向手部。",
};

export function DirectorPoseInspector({
  value,
  adjustments,
  onPresetChange,
  onAdjustmentsChange,
}: {
  value: DirectorPosePreset;
  adjustments: DirectorPoseAdjustments;
  onPresetChange: (value: DirectorPosePreset) => void;
  onAdjustmentsChange: (value: DirectorPoseAdjustments) => void;
}) {
  const updateAdjustment = (
    key: keyof DirectorPoseAdjustments,
    nextValue: number,
  ) => {
    onAdjustmentsChange({ ...adjustments, [key]: nextValue });
  };

  return (
    <div className="pb-6">
      <div className="px-4 pt-4">
        <p className="text-xs font-medium text-[var(--director-text-dim)]">姿势预设</p>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {POSE_PRESETS.map((preset) => {
            const active = value === preset.value;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={active}
                onClick={() => onPresetChange(preset.value)}
                className={`rounded-lg px-1 py-2 text-[11px] font-medium transition ${
                  active
                    ? "bg-[var(--director-active)] text-[var(--director-text)]"
                    : "bg-[var(--director-panel-alt)] text-[var(--director-text-secondary)] hover:bg-[var(--director-hover)] hover:text-[var(--director-text)]"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="mt-3 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-3 py-2 text-[10px] leading-4 text-cyan-100/70">
          {POSE_DESCRIPTIONS[value]}
        </div>
      </div>

      <div className="mt-5 border-t border-[var(--director-border)] px-4 pt-4">
        <p className="text-xs font-semibold text-[var(--director-text)]">姿势调节</p>
        <p className="mt-1 text-[10px] leading-4 text-[var(--director-text-dim)]">
          所有参数均直接驱动并保存到当前角色骨骼，左右关节使用镜像人体轴。
        </p>
        {POSE_ADJUSTMENT_GROUPS.map((group) => (
          <fieldset key={group.label} className="mt-4">
            <legend className="text-xs font-medium text-[var(--director-text-muted)]">
              {group.label}
            </legend>
            <div className="mt-2 space-y-3">
              {group.controls.map((control) => {
                const controlValue = adjustments[control.key];
                return (
                  <label
                    key={control.key}
                    className="grid grid-cols-[44px_minmax(0,1fr)_70px] items-center gap-3 text-[11px] text-[var(--director-text-muted)]"
                  >
                    <span>{control.label}</span>
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={0.1}
                      value={controlValue}
                      onChange={(event) =>
                        updateAdjustment(
                          control.key,
                          Number(event.target.value),
                        )
                      }
                      className="min-w-0 accent-zinc-100"
                      aria-label={`${group.label}${control.label}`}
                    />
                    <span className="rounded-lg bg-[var(--director-border-strong)] px-2 py-2 text-center text-xs font-medium text-[var(--director-text)]">
                      <DecimalNumberInput
                        value={controlValue}
                        min={control.min}
                        max={control.max}
                        step={0.1}
                        precision={2}
                        onValueChange={(nextValue) =>
                          updateAdjustment(control.key, nextValue)
                        }
                        className="w-full bg-transparent text-center outline-none"
                        ariaLabel={`${group.label}${control.label}数值`}
                      />
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}

        {LIMB_POSE_GROUPS.map((group) => (
          <fieldset
            key={group.label}
            className="mt-5 border-t border-[var(--director-border)] pt-4"
          >
            <legend className="px-1 text-xs font-medium text-[var(--director-text-dim)]">
              {group.label}
            </legend>
            <div className="mt-2 space-y-4">
              {group.sides.map((side) => (
                <div key={side.label}>
                  <p className="text-[11px] font-medium text-[var(--director-text-muted)]">
                    {side.label}
                  </p>
                  <div className="mt-2 space-y-3">
                    {side.controls.map((control) => (
                      <label
                        key={control.key}
                        className="grid grid-cols-[44px_minmax(0,1fr)_70px] items-center gap-3 text-[11px] text-[var(--director-text-muted)]"
                      >
                        <span>{control.label}</span>
                        <input
                          type="range"
                          min={control.min}
                          max={control.max}
                          step={0.1}
                          value={adjustments[control.key]}
                          onChange={(event) =>
                            updateAdjustment(
                              control.key,
                              Number(event.target.value),
                            )
                          }
                          className="min-w-0 accent-zinc-100"
                          aria-label={`${group.label}${side.label}${control.label}`}
                        />
                        <span className="rounded-lg bg-[var(--director-border-strong)] px-2 py-2 text-center text-xs font-medium text-[var(--director-text)]">
                          <DecimalNumberInput
                            value={adjustments[control.key]}
                            min={control.min}
                            max={control.max}
                            step={0.1}
                            precision={2}
                            onValueChange={(nextValue) =>
                              updateAdjustment(control.key, nextValue)
                            }
                            className="w-full bg-transparent text-center outline-none"
                            ariaLabel={`${group.label}${side.label}${control.label}数值`}
                          />
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
