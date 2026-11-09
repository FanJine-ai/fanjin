import { publicModelFields } from "@/lib/minimaxH3PublicIdentity";
import express from "express";
import { z } from "zod";
import { billingLedgerStatuses, billingLedgerTypes, listBillingLedger } from "@/lib/billing";
import { success } from "@/lib/responseFormat";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireWorkspacePermission("billing:read"));

const bodySchema = z.object({
  workspaceId: z.string().optional().nullable(),
  type: z.enum(billingLedgerTypes).optional().nullable(),
  status: z.enum(billingLedgerStatuses).optional().nullable(),
  taskId: z.string().optional().nullable(),
  pageNum: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
});

function workspaceIdOf(req: express.Request, workspaceId?: string | null): string {
  return workspaceId || (req as any).auth?.workspaceId || "default";
}

const handleLedger: express.RequestHandler = async (req, res) => {
  const source = req.method === "GET"
    ? {
      ...req.query,
      ...(req.query.pageNum === undefined
        ? {}
        : { pageNum: Number(req.query.pageNum) }),
      ...(req.query.pageSize === undefined
        ? {}
        : { pageSize: Number(req.query.pageSize) }),
    }
    : (req.body ?? {});
  const parsed = bodySchema.safeParse(source);
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  res.status(200).send(
    success(
      publicModelFields(await listBillingLedger({
        ...parsed.data,
        workspaceId: workspaceIdOf(req, parsed.data.workspaceId),
      })),
    ),
  );
};

router.get("/", handleLedger);
router.post("/", handleLedger);

export default router;
