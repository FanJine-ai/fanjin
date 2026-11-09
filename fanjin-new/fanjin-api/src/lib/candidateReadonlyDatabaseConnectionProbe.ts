import type { Request, Response } from "express";

type Probe = () => Promise<string>;

let installedProbe: Probe | null = null;

export function installCandidateReadonlyDatabaseConnectionProbe(
  probe: Probe,
): () => void {
  if (
    installedProbe
    || process.env.FANJIN_READONLY_EVIDENCE_MODE !== "1"
    || process.env.FANJIN_PROCESS_ROLE !== "api"
    || process.env.FANJIN_SQLITE_READONLY !== "1"
  ) {
    throw new Error("CANDIDATE_READONLY_DATABASE_PROBE_INSTALL_FORBIDDEN");
  }
  installedProbe = probe;
  return () => {
    if (installedProbe === probe) installedProbe = null;
  };
}

export async function candidateReadonlyDatabaseConnectionProbeHandler(
  _request: Request,
  response: Response,
): Promise<void> {
  const probe = installedProbe;
  if (!probe) {
    response.status(404).send({ code: "NOT_FOUND" });
    return;
  }
  try {
    const databaseConnectionBinding = await probe();
    if (!/^sha256:[a-f0-9]{64}$/.test(databaseConnectionBinding)) {
      throw new Error("binding invalid");
    }
    response.status(200).send({
      ok: true,
      databaseConnectionBinding,
      queryOnly: true,
      journalMode: "delete",
      attachedDatabaseCount: 0,
    });
  } catch {
    response.status(409).send({
      code: "CANDIDATE_READONLY_DATABASE_CONNECTION_INVALID",
    });
  }
}
