import { z } from "zod";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { AgentToolGatewayError } from "@/agent-runtime/tools/errors";
import {
  defineAgentTool,
  type AgentToolAuthorizationContext,
} from "@/agent-runtime/tools/registry";
import { sessionGetOutputSchema } from "@/agent-runtime/tools/packages/session";

export const contextSnapshotGetInputSchema = z.object({}).strict();

const contextProjectSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(200).nullable(),
  intro: z.string().max(20_000).nullable(),
  type: z.string().max(500).nullable(),
  artStyle: z.string().max(2_000).nullable(),
  projectType: z.string().max(200).nullable(),
  mode: z.string().max(100).nullable(),
  videoRatio: z.string().max(100).nullable(),
  revision: z.number().int().positive(),
}).strict();

const creationSessionSchema = sessionGetOutputSchema;

export const contextSnapshotGetOutputSchema = z.object({
  project: contextProjectSchema,
  creationSession: creationSessionSchema.nullable(),
}).strict();

function nullableString(value: unknown, maxLength: number): string | null {
  return value == null ? null : String(value).slice(0, maxLength);
}

function projectRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new AgentToolGatewayError("context_snapshot_invalid", "当前项目 revision 无效", { status: 409 });
  }
  return revision;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentToolGatewayError("context_snapshot_invalid", "当前创作上下文无法安全读取", { status: 409 });
  }
}

async function loadContextSnapshot(context: AgentToolAuthorizationContext) {
  const project = await context.database("o_project")
    .where({ id: context.projectId, workspaceId: context.workspaceId })
    .select("id", "name", "intro", "type", "artStyle", "projectType", "mode", "videoRatio", "revision")
    .first();
  if (!project) {
    throw new AgentToolGatewayError("context_scope_invalid", "当前项目上下文已失效", { status: 409 });
  }

  const thread = await context.database("o_agent_thread")
    .where({
      id: context.threadId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      status: "active",
    })
    .select("sessionId")
    .first();
  if (!thread) {
    throw new AgentToolGatewayError("context_scope_invalid", "当前 Thread 上下文已失效", { status: 409 });
  }

  let creationSession: z.infer<typeof creationSessionSchema> | null = null;
  if (thread.sessionId != null) {
    const session = await context.database("o_creation_session")
      .where({
        id: String(thread.sessionId),
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        status: "active",
      })
      .whereNull("archivedAt")
      .select(
        "id",
        "goal",
        "mode",
        "parameters",
        "selectedAssetVersionIds",
        "canvasId",
        "version",
        "updatedAt",
      )
      .first();
    if (!session) {
      throw new AgentToolGatewayError("context_session_invalid", "当前 Thread 绑定的创作会话已失效", { status: 409 });
    }
    const parsedSession = creationSessionSchema.safeParse({
      id: String(session.id),
      goal: String(session.goal || ""),
      mode: session.mode,
      parameters: parseJson(session.parameters),
      selectedAssetVersionIds: parseJson(session.selectedAssetVersionIds),
      canvasId: nullableString(session.canvasId, 200),
      version: Number(session.version),
      updatedAt: Number(session.updatedAt),
    });
    if (!parsedSession.success) {
      throw new AgentToolGatewayError(
        "context_snapshot_invalid",
        "当前创作会话包含无效或超限字段",
        { status: 409 },
      );
    }
    creationSession = parsedSession.data;
  }

  return {
    project: {
      id: Number(project.id),
      name: nullableString(project.name, 200),
      intro: nullableString(project.intro, 20_000),
      type: nullableString(project.type, 500),
      artStyle: nullableString(project.artStyle, 2_000),
      projectType: nullableString(project.projectType, 200),
      mode: nullableString(project.mode, 100),
      videoRatio: nullableString(project.videoRatio, 100),
      revision: projectRevision(project.revision),
    },
    creationSession,
  };
}

export const CONTEXT_SNAPSHOT_GET_TOOL = defineAgentTool({
  manifest: {
    name: "context.snapshot.get",
    version: "1.2.0",
    displayName: "读取当前创作上下文",
    description: "读取当前 Agent Run 所属项目与 Thread 绑定创作会话的安全快照。",
    riskClass: "R0",
    availability: { state: "available", sincePhase: "A2" },
    requiredPermissions: ["project:read"],
    resourceTypes: ["project", "creation_session"],
    mutatesState: false,
    metered: false,
  },
  inputSchema: contextSnapshotGetInputSchema,
  outputSchema: contextSnapshotGetOutputSchema,
  async resolveAuthorizationEvidence(_input, context) {
    const snapshot = await loadContextSnapshot(context);
    return {
      resourceRefs: snapshot.creationSession == null
        ? []
        : [
            ...snapshot.creationSession.selectedAssetVersionIds.map((id) => ({
              type: "assetVersionIds" as const,
              id,
            })),
            ...(snapshot.creationSession.canvasId == null
              ? []
              : [{ type: "canvasIds" as const, id: snapshot.creationSession.canvasId }]),
          ],
      resourceVersions: {
        [`project:${snapshot.project.id}`]: String(snapshot.project.revision),
        [`project_snapshot:${snapshot.project.id}`]: hashIdempotencyRequest(snapshot.project),
        ...(snapshot.creationSession == null
          ? {}
          : {
              [`creation_session:${snapshot.creationSession.id}`]: String(snapshot.creationSession.version),
              [`creation_session_snapshot:${snapshot.creationSession.id}`]: hashIdempotencyRequest(snapshot.creationSession),
            }),
      },
    };
  },
  async execute(_input, context) {
    return loadContextSnapshot(context);
  },
});
