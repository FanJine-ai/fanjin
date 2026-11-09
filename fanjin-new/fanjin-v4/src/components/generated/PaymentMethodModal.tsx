type Props = {
  amount: number;
  onClose: () => void;
  onConfirm: (paymentMethod: "alipay" | "wechat") => void;
};

export default function PaymentMethodModal({ amount, onClose, onConfirm }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-md bg-white p-6 shadow-xl">
        <h2 className="text-lg font-bold text-gray-950">选择支付方式</h2>
        <p className="mt-2 text-sm text-gray-600">金额：{amount}</p>
        <div className="mt-4 flex gap-3">
          <button className="mh-button-primary" onClick={() => onConfirm("wechat")}>微信支付</button>
          <button className="mh-button-secondary" onClick={() => onConfirm("alipay")}>支付宝</button>
          <button className="mh-button-secondary ml-auto" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
