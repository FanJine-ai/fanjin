import { Link } from "react-router-dom";

export function ModelFlowNav({ active }: { active: "channel" | "pool" | "route" | "price" }) {
  const steps = [
    { id: "channel", label: "1 供应商渠道", path: "/fjadmin/provider-channels" },
    { id: "pool", label: "2 模型池", path: "/fjadmin/model-pool" },
    { id: "route", label: "3 模型路由", path: "/fjadmin/model-management" },
    { id: "price", label: "4 模型管理", path: "/fjadmin/pricing-rules" },
  ] as const;
  return (
    <nav className="modelOpsFlow" aria-label="模型配置链路">
      <span>配置链路</span>
      {steps.map((step, index) => (
        <span className="modelOpsFlow__step" key={step.id}>
          {index ? <span aria-hidden="true">→</span> : null}
          {step.id === active ? <strong aria-current="step">{step.label}</strong> : <Link to={step.path}>{step.label}</Link>}
        </span>
      ))}
    </nav>
  );
}
