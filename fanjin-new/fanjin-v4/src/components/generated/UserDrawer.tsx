type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function UserDrawer({ isOpen, onClose }: Props) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose}>
      <div className="absolute right-0 top-0 h-full w-80 bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-gray-950">用户菜单</h3>
        <p className="mt-2 text-sm text-gray-600">兼容抽屉占位，后续可继续接原版功能。</p>
      </div>
    </div>
  );
}
