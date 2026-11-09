import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { listUserTables } from "@/lib/dbDialect";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const tables = await listUserTables(db);

    const tableInfo = [];
    for (const table of tables) {
      const countResult = await (db as any)(table.name).count({ count: "*" }).first();
      tableInfo.push({
        name: table.name,
        rowCount: Number(countResult?.count ?? 0),
      });
    }

    res.status(200).send(success(tableInfo));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "获取数据库信息失败"));
  }
});
