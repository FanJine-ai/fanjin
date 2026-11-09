import React, { useEffect, useState } from "react";
import { apiPost } from "../api/http";
import { useAuthStore } from "../stores/authStore";

interface VendorChild {
  id: number;
  label: string;
  value: string;
  vendorId: number;
  type: string;
}
interface VendorOption {
  group: string;
  id: number;
  children: VendorChild[];
}

interface Props {
  value?: string;
  onChange?: (value: string, data?: any) => void;
  type?: "text" | "image" | "all" | "video";
  size?: "small" | "medium" | "large";
  placeholder?: string;
  changeConfig?: boolean;
}

export default function ModelSelect({ value = "", onChange, type = "all", size = "medium", placeholder = "请选择模型", changeConfig = false }: Props) {
  const [selectValue, setSelectValue] = useState(value);
  const [optionsData, setOptionsData] = useState<VendorOption[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => { setSelectValue(value); }, [value]);
  useEffect(() => { fetchModels(); }, [type]);

  const typeMap: Record<string, string> = { image: "图片模型", text: "文本模型", video: "视频模型" };

  async function fetchModels() {
    try {
      const response = await apiPost("/modelSelect/getModelList", { type }) as any;
      const groupMap = new Map<string, VendorOption>();
      const modelList = Array.isArray(response.data) ? response.data : [];
      modelList.forEach((item: any) => {
        const groupKey = item.id;
        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, { group: item.name, id: item.id, children: [] });
        }
        groupMap.get(groupKey)!.children.push({
          id: item.id, label: item.label, value: item.value,
          vendorId: item.vendorId, type: typeMap[item.type] || item.type,
        });
      });
      setOptionsData(Array.from(groupMap.values()));
    } catch { setOptionsData([]); }
  }

  async function handleChange(val: string) {
    setSelectValue(val);
    if (changeConfig) {
      const { data } = await apiPost("/modelSelect/getModelDetail", { modelId: val }) as any;
      onChange?.(val, data);
    } else {
      onChange?.(val);
    }
  }

  const sizeMap = { small: { height: 28, fontSize: 12 }, medium: { height: 32, fontSize: 13 }, large: { height: 36, fontSize: 14 } };
  const sz = sizeMap[size] || sizeMap.medium;

  const allOptions = optionsData.flatMap((g) => g.children);

  return (
    <div style={{ position: "relative", minWidth: 120 }}>
      <select
        value={selectValue}
        onChange={(e) => handleChange(e.target.value)}
        style={{ width: "100%", height: sz.height, padding: "0 8px", border: "1px solid #e4e4e7", borderRadius: 6, fontSize: sz.fontSize, color: "#18181b", background: "#fff", cursor: "pointer", outline: "none", appearance: "auto" }}
      >
        <option value="">{placeholder}</option>
        {optionsData.map((group) => (
          <optgroup key={group.id} label={group.group}>
            {group.children.map((item) => (
              <option key={`${item.id}-${item.value}`} value={`${item.id}:${item.value}`}>{item.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
