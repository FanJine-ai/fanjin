import type { NextFunction, Request, Response } from "express";
import { writeAuditLog } from "@/lib/audit";
import { error, success } from "@/lib/responseFormat";
import {
  ADMIN_AUTOMATION_PREFIX, adminAutomationOperations, canDiscoverAdminOperation,
  describeAdminOperation, isAdminAutomationRole, resolveAdminAutomationCall,
} from "@/lib/adminAutomation";

import { readAdminMachineIdentity } from "@/lib/adminMachineIdentity";
import { AdminMachineCredentialError, issueAdminMachineCredential, listAdminMachineCredentials, revokeAdminMachineCredential } from "@/lib/adminMachineCredentials";
import { consumeStepUpProof, StepUpError } from "@/lib/stepUpAuth";
import { db } from "@/utils/db";

async function deny(req: Request, res: Response, status: number, code: string) {
  try {
    await writeAuditLog(req, {
      action: "admin.automation.denied", resourceType: "admin_automation", required: true,
      metadata: { path: req.path, outcome: "denied", denialCode: code },
    });
  } catch {
    return res.status(503).send(error("安全审计暂不可用", { code: "FJADMIN_AUDIT_UNAVAILABLE" }));
  }
  return res.status(status).send(error("平台管理工具访问被拒绝", { code }));
}
/** Mount AFTER live human/machine auth and BEFORE every canonical admin guard/router. */
export async function adminAutomationMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path !== ADMIN_AUTOMATION_PREFIX && !req.path.startsWith(`${ADMIN_AUTOMATION_PREFIX}/`)) return next();
  res.setHeader("Cache-Control", "no-store");
  const auth = (req as any).auth;
  const machine = readAdminMachineIdentity(req);
  // Only server-verified machine identity or a live human session; ordinary
  // user relay keys and client-supplied role flags never establish authority.
  if ((!machine && !auth?.session?.id) || !auth?.user?.id || (req as any).apiKey) return deny(req, res, 401, "ADMIN_SESSION_REQUIRED");
  if (!isAdminAutomationRole(auth.user.role)) return deny(req, res, 403, "PLATFORM_ADMIN_REQUIRED");
  try {
    if (req.method === "POST" && req.path === `${ADMIN_AUTOMATION_PREFIX}/revoke-self`) {
      if (!machine) return deny(req, res, 401, "ADMIN_MACHINE_KEY_REQUIRED");
      return res.send(success(await revokeAdminMachineCredential(req, machine.id)));
    }
    // Credential provisioning is an authenticated human control-plane action.
    // A machine key can never mint another key or expand its own permissions.
    if (req.path.startsWith(`${ADMIN_AUTOMATION_PREFIX}/credentials`)) {
      if (machine) return deny(req, res, 403, "ADMIN_MACHINE_ENDPOINT_FORBIDDEN");
      if (req.method === "GET" && req.path === `${ADMIN_AUTOMATION_PREFIX}/credentials`) {
        return res.send(success(await listAdminMachineCredentials(Number(auth.user.id))));
      }
      if (req.method !== "POST" || ![`${ADMIN_AUTOMATION_PREFIX}/credentials/create`, `${ADMIN_AUTOMATION_PREFIX}/credentials/revoke`].includes(req.path)) {
        return deny(req, res, 404, "ADMIN_AUTOMATION_ENDPOINT_UNKNOWN");
      }
      await consumeStepUpProof(db, { userId: Number(auth.user.id), sessionId: String(auth.session.id),
        scope: "account.security.update", proof: String(req.headers["x-fanjin-step-up"] || "") });
      if (req.path.endsWith("/create")) return res.send(success(await issueAdminMachineCredential(req, req.body)));
      if (typeof req.body?.id !== "string") return deny(req, res, 400, "ADMIN_MACHINE_INPUT_INVALID");
      return res.send(success(await revokeAdminMachineCredential(req, req.body.id)));
    }
  } catch (caught) {
    if (caught instanceof AdminMachineCredentialError || caught instanceof StepUpError) return deny(req, res, caught.status, caught.code);
    return next(caught);
  }
  if (req.method === "GET" && req.path === `${ADMIN_AUTOMATION_PREFIX}/tools`) {
    return res.send(success({ tools: adminAutomationOperations()
      .filter(operation => canDiscoverAdminOperation(auth.user.role, operation, machine?.permissions))
      .map(operation => describeAdminOperation(operation, Boolean(machine))),
      authentication: machine ? { kind: "admin_machine_key", id: machine.id, expiresAt: machine.expiresAt } : { kind: "human_session" } }));
  }
  if (req.method !== "POST" || req.path !== `${ADMIN_AUTOMATION_PREFIX}/call`) return deny(req, res, 404, "ADMIN_AUTOMATION_ENDPOINT_UNKNOWN");
  const input = req.body;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["name", "arguments"].includes(key))) return deny(req, res, 400, "ADMIN_TOOL_ARGUMENTS_INVALID");
  let call: ReturnType<typeof resolveAdminAutomationCall>;
  try {
    call = resolveAdminAutomationCall(input.name, input.arguments === undefined ? {} : input.arguments);
  } catch (caught) {
    const code = (caught as Error).message;
    if (!["ADMIN_TOOL_UNKNOWN", "ADMIN_TOOL_ARGUMENTS_INVALID"].includes(code)) return next(caught);
    return deny(req, res, code === "ADMIN_TOOL_UNKNOWN" ? 404 : 400, code);
  }
  // Do NOT call handlers directly: canonical policy, Root gates, authentication, audit
  // and route validation all run downstream, as they do for the admin console.
  (req as any).adminAutomation = { transport: "cli_mcp", tool: call.operation.name };
  req.method = call.operation.method;
  req.url = call.url;
  req.originalUrl = call.url;
  req.body = call.body;
  return next();
}
