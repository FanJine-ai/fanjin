import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { quoteSqlIdentifier, tableExists } from "@/lib/dbDialect";

const router = express.Router();

export default router.post("/", requirePlatformAdmin, async (req, res) => {
  if (process.env.FANJIN_ENABLE_DESTRUCTIVE_ADMIN !== "1") {
    return res.status(403).send({ message: "生产保护已开启：清空表接口未启用" });
  }
  try {
    const { tableName } = req.body;
    if (!tableName || typeof tableName !== "string") {
      return res.status(400).send(error("请提供有效的表名"));
    }

    // 验证表名存在（防止SQL注入）
    quoteSqlIdentifier(tableName);
    if (!(await tableExists(db, tableName))) {
      return res.status(400).send(error("表不存在"));
    }

    await (db as any)(tableName).delete();

    res.status(200).send(success(`表 ${tableName} 已清空`));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清空表失败"));
  }
});
