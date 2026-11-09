import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.get("/", async (req, res) => {
  const authUser = (req as any).auth?.user || (req as any).user;
  const userId = authUser?.id;
  const query = u.db("o_user").select(
    "id",
    "name",
    "email",
    "displayName",
    "role",
    "status",
    "currentWorkspaceId",
    "createdAt",
    "updatedAt",
    "lastLoginAt",
  );
  const data = userId ? await query.where("id", Number(userId)).first() : await query.first();
  res.status(200).send(success(data));
});
