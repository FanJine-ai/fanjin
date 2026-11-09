import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";

import {
  CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_LIFETIME_MS,
  candidateExactAuthorizationAvailableScopeDigest,
  candidateExactAuthorizationDigest,
  candidateExactAuthorizationSessionBinding,
  candidateExactAuthorizationWalletBinding,
  candidateExactAuthorizationWorkspaceBinding,
  sealCandidateExactAuthorizationReceipt,
  type CandidateExactAuthorizationBillingReadback,
  type CandidateExactAuthorizationCanonicalOperation,
  type CandidateExactAuthorizationKey,
  type CandidateExactAuthorizationRuntimeSession,
} from "@/lib/candidateExactAuthorizationCanonical";
import {
  CandidateExactAuthorizationQuoteReadError,
  candidateExactAuthorizationReadbackEqual,
  readCandidateExactAuthorizationBillingReadback,
  resolveCandidateExactAuthorizationCanonicalOperations,
} from "@/lib/candidateExactAuthorizationQuoteReadModel";
import {
  candidateExactAuthorizationRuntimeSessionForRequest,
  formalCandidateRuntimeSessionForRequest,
} from "@/lib/candidateRuntimeAttestation";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { requireProjectPermission } from "@/middleware/projectAccess";

const CAPTURE_PATHS = Object.freeze({
  "/quotes/quick-720p": "quick/720p",
  "/quotes/quick-1080p": "quick/1080p",
  "/quotes/canvas-720p": "canvas/720p",
  "/quotes/canvas-1080p": "canvas/1080p",
  "/quotes/agent-720p": "agent/720p",
  "/quotes/agent-1080p": "agent/1080p",
  "/preflights/full-matrix-mixed": "full-matrix/mixed",
} satisfies Record<string, CandidateExactAuthorizationKey>);

const candidateKeySchema = z.enum([
  "quick/720p",
  "quick/1080p",
  "canvas/720p",
  "canvas/1080p",
  "agent/720p",
  "agent/1080p",
  "full-matrix/mixed",
]);

const captureBodySchema = z.object({
  candidateKey: candidateKeySchema,
  projectId: z.number().int().positive(),
  capturedAt: z.string().datetime({ offset: false }),
  expiresAt: z.string().datetime({ offset: false }),
  zeroPaidQuoteOnly: z.literal(true),
}).strict();

type CaptureRequest = z.infer<typeof captureBodySchema>;

type CaptureDependencies = Readonly<{
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => number;
  resolveRuntimeSession?: (
    request: Request,
  ) => CandidateExactAuthorizationRuntimeSession | null;
  resolveFormalRuntimeSession?: (
    request: Request,
  ) => CandidateExactAuthorizationRuntimeSession | null;
  resolveOperations?: (input: {
    candidateKey: CandidateExactAuthorizationKey;
    workspaceId: string;
  }) => Promise<readonly CandidateExactAuthorizationCanonicalOperation[]>;
  readBilling?: (input: {
    workspaceId: string;
    sessionUserId: number;
  }) => Promise<CandidateExactAuthorizationBillingReadback>;
  workspacePermission?: RequestHandler;
  projectPermission?: RequestHandler;
}>;

type AuthorizedRequest = Request & {
  auth?: {
    user?: { id?: unknown };
    workspaceId?: unknown;
  };
};

type CaptureLocals = {
  candidateExactAuthorizationSession?: CandidateExactAuthorizationRuntimeSession;
  candidateExactAuthorizationBody?: CaptureRequest;
};

function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new CandidateExactAuthorizationQuoteReadError(
        "CANDIDATE_EXACT_AUTHORIZATION_COST_OVERFLOW",
      );
    }
  }
  return total;
}

function exactOperations(
  before: readonly CandidateExactAuthorizationCanonicalOperation[],
  after: readonly CandidateExactAuthorizationCanonicalOperation[],
): boolean {
  return candidateExactAuthorizationDigest(before)
    === candidateExactAuthorizationDigest(after);
}

function captureGate(
  dependencies: CaptureDependencies,
  candidateKey: CandidateExactAuthorizationKey,
): RequestHandler {
  return (request: AuthorizedRequest, response: Response, next: NextFunction) => {
    const environment = dependencies.environment ?? process.env;
    // Hide the entire capture surface in every ordinary runtime. Production
    // is visible only to the request/session bound to a formal FD4-proven,
    // immutable-artifact authority. This check deliberately precedes body
    // parsing, key validation and RBAC so malformed ordinary probes cannot
    // distinguish the route.
    let formalSession: CandidateExactAuthorizationRuntimeSession | null = null;
    if (environment.NODE_ENV !== "test") {
      if (environment.NODE_ENV === "prod") {
        const formalSessionResolver = dependencies.resolveFormalRuntimeSession
          ?? formalCandidateRuntimeSessionForRequest;
        formalSession = formalSessionResolver(request);
      }
      if (!formalSession) {
        response.status(404).send({ code: "NOT_FOUND" });
        return;
      }
    }
    const parsed = captureBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).send({
        code: "CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_REQUEST_INVALID",
      });
      return;
    }
    if (parsed.data.candidateKey !== candidateKey) {
      response.status(409).send({
        code: "CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_KEY_MISMATCH",
      });
      return;
    }
    const sessionResolver = dependencies.resolveRuntimeSession
      ?? candidateExactAuthorizationRuntimeSessionForRequest;
    const session = formalSession ?? sessionResolver(request);
    const workspaceId = String(request.auth?.workspaceId || "").trim();
    const userId = Number(request.auth?.user?.id || 0);
    if (
      !session
      || !workspaceId
      || session.workspaceId !== workspaceId
      || session.userId !== userId
      || session.projectId !== parsed.data.projectId
    ) {
      response.status(404).send({ code: "NOT_FOUND" });
      return;
    }
    try {
      if (
        candidateExactAuthorizationSessionBinding(session)
          !== candidateExactAuthorizationSessionBinding({
            ...session,
            workspaceId,
            projectId: parsed.data.projectId,
            userId,
          })
      ) {
        response.status(404).send({ code: "NOT_FOUND" });
        return;
      }
    } catch {
      response.status(404).send({ code: "NOT_FOUND" });
      return;
    }
    const now = (dependencies.now ?? Date.now)();
    const capturedAtMs = Date.parse(parsed.data.capturedAt);
    const expiresAtMs = Date.parse(parsed.data.expiresAt);
    if (
      !Number.isFinite(now)
      || capturedAtMs > now
      || now >= expiresAtMs
      || expiresAtMs <= capturedAtMs
      || expiresAtMs - capturedAtMs
        > CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_LIFETIME_MS
    ) {
      response.status(409).send({
        code: "CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_WINDOW_INVALID",
      });
      return;
    }
    const locals = response.locals as CaptureLocals;
    locals.candidateExactAuthorizationSession = session;
    locals.candidateExactAuthorizationBody = parsed.data;
    next();
  };
}

function handler(
  dependencies: CaptureDependencies,
  candidateKey: CandidateExactAuthorizationKey,
): RequestHandler {
  const resolveOperations = dependencies.resolveOperations
    ?? resolveCandidateExactAuthorizationCanonicalOperations;
  const readBilling = dependencies.readBilling
    ?? readCandidateExactAuthorizationBillingReadback;
  return async (_request, response) => {
    const locals = response.locals as CaptureLocals;
    const session = locals.candidateExactAuthorizationSession;
    const body = locals.candidateExactAuthorizationBody;
    if (!session || !body) {
      response.status(404).send({ code: "NOT_FOUND" });
      return;
    }
    try {
      const billingBefore = await readBilling({
        workspaceId: session.workspaceId,
        sessionUserId: session.userId,
      });
      const operationsBefore = await resolveOperations({
        candidateKey,
        workspaceId: session.workspaceId,
      });
      const operationsAfter = await resolveOperations({
        candidateKey,
        workspaceId: session.workspaceId,
      });
      const billingAfter = await readBilling({
        workspaceId: session.workspaceId,
        sessionUserId: session.userId,
      });
      if (
        !candidateExactAuthorizationReadbackEqual(
          billingBefore,
          billingAfter,
        )
        || !exactOperations(operationsBefore, operationsAfter)
      ) {
        throw new CandidateExactAuthorizationQuoteReadError(
          "CANDIDATE_EXACT_AUTHORIZATION_READBACK_DRIFT",
        );
      }
      const maximumCostMicros = safeSum(
        operationsBefore.map((operation) => operation.maximumCostMicros),
      );
      if (
        billingBefore.account.reservedMicros !== 0
        || billingBefore.account.availableMicros < maximumCostMicros
      ) {
        throw new CandidateExactAuthorizationQuoteReadError(
          "CANDIDATE_EXACT_AUTHORIZATION_BUDGET_INSUFFICIENT",
          402,
        );
      }
      const sessionBinding = candidateExactAuthorizationSessionBinding(session);
      const budget = Object.freeze({
        currency: "GU" as const,
        workspaceBinding: candidateExactAuthorizationWorkspaceBinding(
          session.workspaceId,
        ),
        walletBinding: candidateExactAuthorizationWalletBinding(billingBefore),
        availableScopeDigest:
          candidateExactAuthorizationAvailableScopeDigest(billingBefore),
        maximumCostMicros,
        availableMicros: billingBefore.account.availableMicros,
        reservedMicros: 0 as const,
      });
      const directoryDigest = candidateExactAuthorizationDigest(
        operationsBefore.map((operation) => ({
          key: operation.key,
          digest: operation.directoryEntryDigest,
        })),
      );
      const routeDigest = candidateExactAuthorizationDigest(
        operationsBefore.map((operation) => ({
          key: operation.key,
          digest: operation.routeEntryDigest,
        })),
      );
      const pricingDigest = candidateExactAuthorizationDigest(
        operationsBefore.map((operation) => ({
          key: operation.key,
          digest: operation.pricingEntryDigest,
        })),
      );
      const quoteSource = candidateKey === "full-matrix/mixed"
        ? "preflight" as const
        : "quote" as const;
      const quoteDigest = candidateExactAuthorizationDigest({
        candidateKey,
        sessionBinding,
        quoteSource,
        capturedAt: body.capturedAt,
        expiresAt: body.expiresAt,
        directoryDigest,
        routeDigest,
        pricingDigest,
        budget,
        operations: operationsBefore,
      });
      const receipt = sealCandidateExactAuthorizationReceipt({
        format: "fanjin-candidate-exact-authorization-receipt/v1",
        candidateKey,
        candidateIdentity: session.candidateIdentity,
        sessionBinding,
        quoteSource,
        capturedAt: body.capturedAt,
        expiresAt: body.expiresAt,
        directoryDigest,
        routeDigest,
        pricingDigest,
        quoteDigest,
        budget,
        operations: operationsBefore,
      });
      const absorbed = candidateKey === "full-matrix/mixed"
        ? operationsBefore.find((operation) => (
          operation.endpointType === "image_generation"
          && operation.media?.kind === "image"
          && operation.chargedCallCeiling === 1
        ))
        : null;
      if (candidateKey === "full-matrix/mixed" && !absorbed) {
        throw new CandidateExactAuthorizationQuoteReadError(
          "CANDIDATE_EXACT_AUTHORIZATION_BATCH_D_ABSORPTION_MISSING",
        );
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Pragma", "no-cache");
      response.status(200).send({
        data: {
          receipt,
          billingReadback: billingBefore,
          batchDAbsorption: absorbed
            ? {
                absorbedByOperationKey: absorbed.key,
                sameReceiptBinding: true,
                recoveryUpstreamCalls: 0,
                recoveryChargedCalls: 0,
              }
            : null,
        },
        upstreamCalls: 0,
        chargedCalls: 0,
        generationSubmissions: 0,
        writes: 0,
        internalBillingReadbacks: 2,
      });
    } catch (error) {
      const known = error instanceof CandidateExactAuthorizationQuoteReadError;
      response.status(known ? error.status : 409).send({
        code: known
          ? error.code
          : "CANDIDATE_EXACT_AUTHORIZATION_CAPTURE_UNAVAILABLE",
      });
    }
  };
}

export function createCandidateExactAuthorizationCaptureRouter(
  dependencies: CaptureDependencies = {},
): express.Router {
  const router = express.Router();
  const workspacePermission = dependencies.workspacePermission
    ?? requireActiveWorkspacePermission("generation:create");
  const projectPermission = dependencies.projectPermission
    ?? requireProjectPermission("project:read");
  for (const [path, candidateKey] of Object.entries(CAPTURE_PATHS)) {
    router.post(
      path,
      captureGate(dependencies, candidateKey),
      workspacePermission,
      projectPermission,
      handler(dependencies, candidateKey),
    );
  }
  return router;
}

export const candidateExactAuthorizationCapturePaths = CAPTURE_PATHS;

export default createCandidateExactAuthorizationCaptureRouter();
