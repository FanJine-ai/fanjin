import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { authenticateSocketToken, SocketAuthContext } from "@/socket/auth";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { runBillingContext } from "@/lib/billingContext";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";

async function authorizeContext(auth: SocketAuthContext, projectId: number) {
  const platformRole = ["root", "admin", "super_admin"].includes(
    String(auth.user.role || "").toLowerCase(),
  );
  if (!platformRole && !auth.workspaceId) {
    return {
      allowed: false,
      status: 403,
      message: "工作区上下文不可用",
    };
  }
  return checkProjectPermission({
    projectId,
    userId: auth.user.id,
    role: auth.user.role,
    permission: "project:write",
    authWorkspaceId: auth.workspaceId,
  });
}

export async function authorizeScriptAgentToken(rawToken: unknown, projectId: number) {
  const authResult = await authenticateSocketToken(rawToken);
  if (!authResult.ok) {
    return { ok: false as const, code: "SOCKET_AUTH_FAILED", message: authResult.message };
  }
  const access = await authorizeContext(authResult.auth, projectId);
  if (!access.allowed) {
    return {
      ok: false as const,
      code: "SOCKET_PROJECT_ACCESS_DENIED",
      message: access.message,
    };
  }
  return { ok: true as const, auth: authResult.auth };
}

export default (nsp: Namespace) => {
  // Namespace middleware runs before Socket.IO emits the namespace CONNECT
  // acknowledgement. A raw `40/...` ACK therefore proves that authentication
  // and project access succeeded, rather than preceding a later disconnect.
  nsp.use((socket, next) => {
    void (async () => {
      if (isRecoveryOnlyMode()) {
        throw new Error("RECOVERY_ONLY_MUTATION_BLOCKED");
      }
      const isolationKey = String(socket.handshake.auth.isolationKey || "").trim();
      if (!isolationKey) throw new Error("SOCKET_ISOLATION_KEY_REQUIRED");
      const projectId = Number(socket.handshake.auth.projectId || 0);
      const authorization = await authorizeScriptAgentToken(
        socket.handshake.auth.token,
        projectId,
      );
      if (!authorization.ok) throw new Error(authorization.code);
      socket.data.authorizedContext = {
        auth: authorization.auth,
        isolationKey,
        projectId,
      };
    })().then(
      () => next(),
      (error: unknown) => next(error instanceof Error ? error : new Error("SOCKET_AUTH_FAILED")),
    );
  });

  nsp.on("connection", (socket: Socket) => {
    const authorized = socket.data.authorizedContext as {
      auth: SocketAuthContext;
      isolationKey: string;
      projectId: number;
    } | undefined;
    if (!authorized) {
      socket.disconnect();
      return;
    }
    const { auth, isolationKey, projectId } = authorized;

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string }) => {
      if (isRecoveryOnlyMode()) {
        socket.emit("authorization_error", {
          code: "RECOVERY_ONLY_MUTATION_BLOCKED",
          message: "恢复候选环境不允许运行脚本 Agent",
        });
        socket.disconnect(true);
        return;
      }
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "统筹");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        // A connected socket is not a durable authorization grant. Re-read
        // session, user, workspace, membership, role, and project authority
        // for every privileged event so suspension/demotion takes effect on
        // the next event without waiting for disconnect or token expiry.
        const liveAuthorization = await authorizeScriptAgentToken(auth.token, projectId);
        if (!liveAuthorization.ok) {
          socket.emit("authorization_error", {
            code: "SOCKET_AUTHORITY_STALE",
            message: liveAuthorization.message,
          });
          socket.disconnect(true);
          return;
        }
        // 把 socket 会话的工作区归属注入计费上下文，供 agent 内部 u.Ai 调用统一扣费
        await runBillingContext(
          {
            workspaceId: liveAuthorization.auth.workspaceId ?? null,
            userId: liveAuthorization.auth.user.id,
            projectId,
            requestId: `script-agent:${socket.id}:${msg.id}`,
          },
          () => agent.runDecisionAI(ctx),
        );
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[scriptAgent] chat error:", u.error(err).message);
          msg.error(u.error(err).message)
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });

    // 断连时中止正在运行的 AI 任务，避免 agent 继续跑完并持续调用上游/计费。
    // 注意：disconnect 是单 socket 事件，必须注册在连接内的 socket 上，
    // nsp.on("disconnect") 永远不会触发（属死代码）。
    socket.on("disconnect", () => {
      abortController?.abort();
      abortController = null;
      console.log("[scriptAgent] 已断开连接:", socket.id);
    });
  });
};
