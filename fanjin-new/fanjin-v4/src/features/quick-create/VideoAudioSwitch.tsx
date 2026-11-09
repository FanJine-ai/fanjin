import { Volume2, VolumeX } from "lucide-react";
import "./VideoAudioSwitch.css";

type Props = {
  checked: boolean;
  supported: boolean;
  onChange: (checked: boolean) => void;
};

export default function VideoAudioSwitch({ checked, supported, onChange }: Props) {
  const enabled = supported && checked;
  const Icon = enabled ? Volume2 : VolumeX;
  return (
    <button
      className="videoAudioSwitch"
      type="button"
      role="switch"
      aria-label="同步生成音频"
      aria-checked={enabled}
      disabled={!supported}
      title={supported ? "同步生成音频" : "当前模型不支持同步生成音频"}
      onClick={() => onChange(!checked)}
    >
      <span className="videoAudioSwitchLabel"><Icon size={17} aria-hidden="true" />同步生成音频</span>
      <span className="videoAudioSwitchState" aria-hidden="true">
        <span>{supported ? enabled ? "已开启" : "已关闭" : "模型不支持"}</span>
        <span className="videoAudioSwitchTrack"><span className="videoAudioSwitchThumb" /></span>
      </span>
    </button>
  );
}
