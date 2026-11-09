import express from "express";
import { z } from "zod";
import { AgentRuntimeConfigService } from "@/agent-runtime/agentRuntimeConfigService";
import {
  agentRuntimeConfigRegistryDto,
  toAgentRoleRuntimeConfigDto,
} from "@/agent-runtime/configAdminDto";
import { AGENT_ROLES } from "@/agent-runtime/contracts";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router({ mergeParams: true });
const configService = new AgentRuntimeConfigService(db);

// Independent platform-admin control plane: deliberately do not install the
// Agent Runtime data-plane feature gate here. PUT remains protected by the
// global scoped step-up middleware, revision CAS and sanitized audit logging.
router.use(requirePlatformAdmin);

const roleSchema = z.enum(AGENT_ROLES);
const referenceSchema = z.object({
  key: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(200),
}).strict();
const saveSchema = z.object({
  promptRef: referenceSchema,
  skillRefs: z.array(referenceSchema).max(50),
  modelProfileRef: referenceSchema,
  modelAliasOverride: z.string().trim().max(200).nullable().optional(),
  temperatureMilli: z.number().int(),
  maxOutputTokens: z.number().int(),
  enabled: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

function invalidRequest(res: express.Response, issues: z.core.$ZodIssue[]) {
  return res.status(400).send({
    code: "invalid_request",
    message: "参数错误",
    errors: issues,
  });
}

router.get("/", async (req, res) => {
  const parsedRole = roleSchema.safeParse((req.params as Record<string, unknown>).role);
  if (!parsedRole.success) return invalidRequest(res, parsedRole.error.issues);

  try {
    const config = await configService.getRoleConfig(parsedRole.data);
    return res.status(200).send(agentSuccess({
      config: toAgentRoleRuntimeConfigDto(config),
      registry: agentRuntimeConfigRegistryDto(parsedRole.data),
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.put("/", async (req, res) => {
  const parsedRole = roleSchema.safeParse((req.params as Record<string, unknown>).role);
  if (!parsedRole.success) return invalidRequest(res, parsedRole.error.issues);
  const parsedBody = saveSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return invalidRequest(res, parsedBody.error.issues);

  try {
    const body = parsedBody.data;
    const updatedBy = Number((req as any).auth?.user?.id || 0);
    const saved = await configService.saveRoleConfig({
      role: parsedRole.data,
      promptKey: body.promptRef.key,
      promptVersion: body.promptRef.version,
      skillRefs: body.skillRefs,
      modelProfileKey: body.modelProfileRef.key,
      modelProfileVersion: body.modelProfileRef.version,
      modelAliasOverride: body.modelAliasOverride,
      temperatureMilli: body.temperatureMilli,
      maxOutputTokens: body.maxOutputTokens,
      enabled: body.enabled,
      expectedRevision: body.expectedRevision,
      updatedBy,
    });
    const config = toAgentRoleRuntimeConfigDto(saved);

    await writeAuditLog(req, {
      action: "admin.agent_runtime_config.update",
      resourceType: "agent_runtime_config",
      resourceId: parsedRole.data,
      metadata: {
        expectedRevision: body.expectedRevision,
        revision: saved.revision,
        promptRef: config.promptRef,
        skillRefs: config.skillRefs,
        modelProfileRef: config.modelProfileRef,
        hasModelAliasOverride: config.modelAliasOverride !== null,
        temperatureMilli: config.temperatureMilli,
        maxOutputTokens: config.maxOutputTokens,
        enabled: config.enabled,
      },
    });

    return res.status(200).send(agentSuccess({ config }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
