import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import initDB from "@/lib/initDB";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { dropAllUserTables, quoteSqlIdentifier, tableExists } from "@/lib/dbDialect";

const router = express.Router();

export default router.post("/", requirePlatformAdmin, async (req, res) => {
  if (process.env.FANJIN_ENABLE_DESTRUCTIVE_ADMIN !== "1") {
    return res.status(403).send({ message: "生产保护已开启：数据库导入接口未启用" });
  }

  try {
    const { tables: importTables } = req.body;
    if (!importTables || typeof importTables !== "object") {
      return res.status(400).send(error("无效的导入数据格式"));
    }

    await dropAllUserTables(db);

    // 重新初始化表结构
    await initDB(db as any);

    // 导入数据
    for (const [tableName, rows] of Object.entries(importTables)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;

      // 验证表名合法性（防止SQL注入）
      quoteSqlIdentifier(tableName);
      if (!(await tableExists(db, tableName))) continue;

      // 清空表数据后插入导入数据
      await (db as any)(tableName).delete();
      // 分批插入，每批100条
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        await (db as any)(tableName).insert(batch);
      }
    }

    await writeAuditLog(req, {
      action: "database.import",
      resourceType: "database",
      metadata: {
        tableCount: Object.keys(importTables).length,
      },
    });

    res.status(200).send(success("数据库导入成功"));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导入失败"));
  }
});
