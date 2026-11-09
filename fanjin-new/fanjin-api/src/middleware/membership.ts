import type { Request, Response, NextFunction } from "express";
import { membershipFeatureForRequest, membershipSharedWriteForRequest } from "@/lib/membershipAccess";
import { assertMembershipFeature } from "@/lib/membership";
import { MembershipError } from "@/lib/membershipCatalog";
import { assertMembershipSharedWrite } from "@/lib/membershipPolicy";
import { db } from "@/utils/db";

/** Runs after authentication and project-context validation; does not replace role permissions. */
export async function membershipHttpGuard(req: Request, res: Response, next: NextFunction) {
  const feature = membershipFeatureForRequest(req.method, req.originalUrl, req.body);
  const sharedWrite = membershipSharedWriteForRequest(req.method, req.originalUrl);
  if (!feature && !sharedWrite) return next();
  try {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    if (!workspaceId) return feature ? res.status(403).send({ message: "缺少工作区上下文" }) : next();
    if (req.body?.workspaceId && String(req.body.workspaceId) !== workspaceId) return res.status(403).send({ message: "工作区上下文不一致" });
    if (feature) await assertMembershipFeature(workspaceId, feature);
    else if (sharedWrite) await assertMembershipSharedWrite(db, workspaceId);
    return next();
  } catch (error) {
    if (error instanceof MembershipError) return res.status(error.status).send({ message: error.message, code: error.code, feature });
    return next(error);
  }
}
