import express from "express";
import { AgentRuntimeConfigService } from "@/agent-runtime/agentRuntimeConfigService";
import {
  agentRuntimeConfigRegistryDto,
  toAgentRoleRuntimeConfigDto,
} from "@/agent-runtime/configAdminDto";
import { AGENT_ROLES } from "@/agent-runtime/contracts";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { db } from "@/utils/db";
import {
  inspectAgentGenerationSubmitConfiguration,
  inspectAgentRuntimeToolingConfiguration,
} from "@/agent-runtime/featureFlags";

const router = express.Router();
const configService = new AgentRuntimeConfigService(db);

// Independent platform-admin control plane: deliberately do not install the
// Agent Runtime data-plane feature gate here. Authentication/admin checks still
// apply, and merely editing configuration never enables model or tool execution.
router.use(requirePlatformAdmin);

router.get("/", async (_req, res) => {
  try {
    const configs = await Promise.all(
      AGENT_ROLES.map(async (role) => toAgentRoleRuntimeConfigDto(
        await configService.getRoleConfig(role),
      )),
    );
    const tooling = inspectAgentRuntimeToolingConfiguration();
    const generationSubmit = inspectAgentGenerationSubmitConfiguration();
    return res.status(200).send(agentSuccess({
      configs,
      registry: agentRuntimeConfigRegistryDto(),
      runtime: {
        available: tooling.enabled,
        status: tooling.status,
        executionConfigured: tooling.executionConfigured,
        toolsEnabled: tooling.toolsEnabled,
        switches: tooling.switches,
        generationSubmit,
      },
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
