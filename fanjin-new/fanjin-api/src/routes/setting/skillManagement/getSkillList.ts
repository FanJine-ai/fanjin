import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { glob as fg } from "tinyglobby";
import u from "@/utils";

const router = express.Router();

export default router.post("/", async (req, res) => {
  const skillsRoot = u.getPath(["skills"]);

  const entries = await fg("**/*.md", {
    cwd: skillsRoot.replace(/\\/g, "/"),
    onlyFiles: true,
  });

  res.status(200).send(success(entries));
});
