import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { getToolService } from "@/tools/runtime";
import { createToolsHttpRouter } from "@/tools/transport";

export default createToolsHttpRouter({ authenticate: apiKeyAuth(), service: getToolService });
