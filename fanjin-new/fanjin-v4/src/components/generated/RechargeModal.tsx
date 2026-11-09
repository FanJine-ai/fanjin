import { X } from "lucide-react";

type Props = {
  onClose: () => void;
};

export default function RechargeModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-950">充值</h2>
          <button onClick={onClose} className="rounded p-2 hover:bg-gray-100" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-gray-600">当前页面将由主充值页接管，这里仅保留兼容壳。</p>
      </div>
    </div>
  );
}
