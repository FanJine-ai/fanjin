import express from "express";
import initDB from "@/lib/initDB";
import { db } from "@/utils/db";
import { success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
const router = express.Router();

function destructiveAdminEnabled() {
    return process.env.FANJIN_ENABLE_DESTRUCTIVE_ADMIN === "1";
}

// 清空数据表
export default router.post(
    "/",
    requirePlatformAdmin,
    async (req, res) => {
        if (!destructiveAdminEnabled()) {
            return res.status(403).send({ message: "生产保护已开启：清空数据接口未启用" });
        }
        await initDB(db, true);
        res.status(200).send(success({ message: "清空数据表成功" }));
    },
);
