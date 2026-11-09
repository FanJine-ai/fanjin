import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import initDB from "@/lib/initDB";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { dropAllUserTables } from "@/lib/dbDialect";

const router = express.Router();

export default router.post("/", requirePlatformAdmin, async (req, res) => {
  if (process.env.FANJIN_ENABLE_DESTRUCTIVE_ADMIN !== "1") {
    return res.status(403).send({ message: "生产保护已开启：清空数据库接口未启用" });
  }
  try {
    await dropAllUserTables(db);

    // 重新初始化数据库
    await initDB(db as any);

    res.status(200).send(success("数据库已清空并重新初始化"));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清除失败"));
  }
});
