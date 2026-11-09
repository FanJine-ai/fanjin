import { writeAuditLog } from "@/lib/audit";
import type { AnalyticsAudit } from "./service";
export const auditAnalyticsExport: AnalyticsAudit = async (subject, input, rows, snapshotAt) => {
  const { cursor: _cursor, ...filters } = input;
  await writeAuditLog({ actor: { actorUserId: subject.userId, actorKind: subject.keyId ? "api_key" : "user" }, workspaceId: subject.workspaceId }, {
    action: "analytics.export", resourceType: "usage_ledger", required: true,
    workspaceId: subject.workspaceId, metadata: { filters, apiKeyId: subject.keyId, rows, snapshotAt, continued: Boolean(_cursor) },
  });
};
