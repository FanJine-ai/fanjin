import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiPost } from "../api/http";
import {
  registerStepUpPresenter,
  StepUpCancelledError,
  type StepUpPrompt,
  type StepUpScope,
} from "../api/stepUp";
import { Button, Dialog, FormField, Input } from "../ui/console";

type PendingPrompt = StepUpPrompt & {
  id: number;
  completed: number;
  consume: (proof: string, scope: StepUpScope, index: number) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type StepUpResult = {
  proof: string;
  scope: StepUpScope;
  expiresAt: number;
  method: "password" | "totp" | "recovery";
};

type StepUpBatchResult = {
  proofs: StepUpResult[];
};

const scopeLabels: Partial<Record<StepUpScope, string>> = {
  "admin.portrait_asset_relay": "操作火山人像资产中转",
  "account.security.update": "更新账号安全设置",
  "account.profile.sensitive": "更新敏感账号资料",
  "admin.user.create": "创建平台用户",
  "admin.user.profile": "更新用户资料",
  "admin.user.status": "更新用户状态",
  "admin.user.role": "更新用户角色",
  "admin.user.commercial": "更新用户商业配置",
  "admin.billing.plan": "维护计费套餐",
  "admin.finance.case": "审批财务工单",
  "admin.finance.gift_grant": "撤销赠送额度",
  "admin.finance.adjustment": "执行财务调账",
  "admin.model_route": "维护模型路由",
  "admin.pricing_rule": "维护模型定价",
  "admin.media_service": "维护媒体服务凭据",
  "admin.provider_channel": "维护供应商通道",
  "admin.redemption": "维护兑换码",
  "admin.relay_task": "操作平台任务",
  "admin.release": "维护平台版本",
  "admin.deployment": "执行生产环境滚动发布",
  "admin.backup.manage": "创建数据库备份",
  "admin.backup.delete": "删除数据库备份",
  "admin.backup.restore": "恢复数据库备份",
  "admin.system_settings": "更新平台设置",
  "api_key.create": "创建 API 密钥",
  "api_key.update": "更新 API 密钥",
  "api_key.rotate": "轮换 API 密钥",
  "api_key.revoke": "删除 API 密钥",
  "workspace.member.manage": "管理工作区成员与邀请",
  "workspace.owner.transfer": "转移工作区所有权",
  "legacy.content_config.manage": "更新内容配置",
};

let promptSequence = 0;

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingPrompt[]>([]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<"verify" | "execute">("verify");
  const passwordRef = useRef<HTMLInputElement>(null);
  const active = queue[0] || null;

  useEffect(() => registerStepUpPresenter((prompt, consume) => new Promise<void>((resolve, reject) => {
    promptSequence += 1;
    setQueue((current) => [...current, { ...prompt, id: promptSequence, completed: 0, consume, resolve, reject }]);
  })), []);

  useEffect(() => {
    setPassword("");
    setCode("");
    setError("");
    setSubmitting(false);
    setPhase("verify");
  }, [active?.id]);

  const operationText = useMemo(() => {
    if (!active) return "";
    const labels = active.scopes.map((scope) => scopeLabels[scope] || scope);
    return Array.from(new Set(labels)).join("、");
  }, [active]);

  function finishActive() {
    setQueue((current) => current.slice(1));
  }

  function cancelActive() {
    if (!active || submitting) return;
    active.reject(new StepUpCancelledError());
    finishActive();
  }

  async function submit() {
    if (!active || submitting) return;
    if (!password) {
      setError("请输入当前账号密码");
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (active.scopes.length > 1 && active.completed === 0) {
        let batch: StepUpBatchResult;
        try {
          batch = await apiPost<StepUpBatchResult>("/account/security/step-up/batch", {
            password,
            code: code.trim() || null,
            scopes: active.scopes,
          });
          if (!Array.isArray(batch?.proofs) || batch.proofs.length !== active.scopes.length) {
            throw new Error("服务端未返回完整的身份验证凭据批次");
          }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "身份验证失败，请重试");
          return;
        }
        setPhase("execute");
        setPassword("");
        setCode("");
        for (let index = 0; index < active.scopes.length; index += 1) {
          const expectedScope = active.scopes[index];
          const result = batch.proofs[index];
          if (!result?.proof || result.scope !== expectedScope) {
            active.reject(new Error("身份验证凭据批次与操作顺序不匹配"));
            finishActive();
            return;
          }
          try {
            await active.consume(result.proof, result.scope, index);
            active.completed = index + 1;
          } catch (caught) {
            active.reject(caught);
            finishActive();
            return;
          }
        }
        active.resolve();
        finishActive();
        return;
      }

      for (let index = active.completed; index < active.scopes.length; index += 1) {
        const scope = active.scopes[index];
        let result: StepUpResult;
        try {
          result = await apiPost<StepUpResult>("/account/security/step-up", {
            password,
            code: code.trim() || null,
            scope,
          });
          if (!result?.proof) throw new Error("服务端未返回身份验证凭据");
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "身份验证失败，请重试";
          setError(active.completed ? `已完成 ${active.completed}/${active.scopes.length} 项；继续验证失败：${message}` : message);
          return;
        }

        try {
          setPhase("execute");
          await active.consume(result.proof, scope, index);
          active.completed = index + 1;
        } catch (caught) {
          active.reject(caught);
          finishActive();
          return;
        }
      }
      active.resolve();
      finishActive();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {children}
      <Dialog
        open={Boolean(active)}
        title={phase === "execute" ? "正在执行已授权操作" : "确认管理员身份"}
        description={phase === "execute"
          ? `身份验证已通过，正在执行：${active?.reason || operationText || "敏感操作"}。请勿关闭页面。`
          : active?.reason || `即将执行：${operationText || "敏感操作"}。验证成功后，本次登录期间不再重复要求密码和 MFA。`}
        size="sm"
        loading={submitting}
        initialFocusRef={passwordRef}
        onOpenChange={(open) => { if (!open) cancelActive(); }}
        data-testid="step-up-dialog"
        footer={(
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <Button variant="secondary" disabled={submitting} onClick={cancelActive}>取消</Button>
            <Button loading={submitting} disabled={!password || phase === "execute"} onClick={() => void submit()}>
              {phase === "execute" ? "正在执行操作" : "验证并继续"}
            </Button>
          </div>
        )}
      >
        {phase === "execute" ? (
          <div role="status" aria-live="polite" style={{ display: "grid", gap: 8 }}>
            <strong>身份验证成功</strong>
            <span style={{ color: "var(--console-text-muted)", fontSize: 13 }}>
              正在完成已授权操作，耗时步骤会继续显示在原页面中。
            </span>
          </div>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }} style={{ display: "grid", gap: 14 }}>
            <FormField label="当前密码" required optionalLabel={null}>
              <Input
                ref={passwordRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(""); }}
              />
            </FormField>
            <FormField label="MFA 验证码或恢复码" optionalLabel="未启用 MFA 可留空" help="已启用 MFA 的账号必须填写；本次登录后续操作将自动复用验证结果。">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => { setCode(event.target.value); setError(""); }}
              />
            </FormField>
            {error ? <div role="alert" style={{ color: "var(--console-danger-text)", fontSize: 13 }}>{error}</div> : null}
            <button type="submit" hidden aria-hidden="true" />
          </form>
        )}
      </Dialog>
    </>
  );
}
