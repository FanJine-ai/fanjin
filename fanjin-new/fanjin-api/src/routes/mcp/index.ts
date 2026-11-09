import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { getToolService } from "@/tools/runtime";
import { createToolsMcpRouter } from "@/tools/transport";

export default createToolsMcpRouter({
  authenticate: apiKeyAuth({ permission: "mcp:connect" }),
  service: getToolService,
});
