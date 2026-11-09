import type {PostgresBackupCommands} from "./backup";
import {createBackup} from "./backup";
import {EXTERNAL_TOOLS_MIGRATION_CHECKSUM, USER_FEEDBACK_MIGRATION_CHECKSUM,
  REFERENCE_DOCUMENT_UPLOAD_MIGRATION_CHECKSUM} from "./migrationCompatibilityCatalog";
import {prepareMaintenanceMigrationCheckpoint, type PrepareMaintenanceMigrationCheckpointInput} from "./maintenanceMigrationCheckpoint";

/** Reviewed online edges are backward-compatible expansions. Do not infer
 * online safety from a version increment or a caller-provided "additive" flag. */
export function assertOnlineExpandCheckpoint(input: Pick<PrepareMaintenanceMigrationCheckpointInput,
  "expectedFromVersion" | "expectedToVersion" | "migrationDefinitions">): void {
  const definitions = input.migrationDefinitions, edge = definitions?.at(-1);
  const approved = [
    {from: 58, to: 59, name: "external_tools", checksum: EXTERNAL_TOOLS_MIGRATION_CHECKSUM},
    {from: 59, to: 60, name: "user_feedback", checksum: USER_FEEDBACK_MIGRATION_CHECKSUM},
    {from: 60, to: 61, name: "reference_document_upload", checksum: REFERENCE_DOCUMENT_UPLOAD_MIGRATION_CHECKSUM},
  ].find(item => item.from === input.expectedFromVersion && item.to === input.expectedToVersion);
  if (!approved || definitions?.length !== approved.to
    || edge?.version !== approved.to || edge.name !== approved.name || edge.checksum !== approved.checksum) {
    throw Object.assign(new Error("Online checkpoint requires an exact reviewed immutable expansion catalog"), {code: "EXPAND_CHECKPOINT_EDGE_NOT_APPROVED"});
  }
}

/** Keep the exporting transaction alive through pg_dump and restore verification.
 * Source counts, source schema and the dump share one snapshot while ordinary
 * application writes continue. The maintenance contract itself stays strict;
 * it compares the restored database against this exact frozen snapshot. */
export async function prepareExpandMigrationCheckpoint(input: PrepareMaintenanceMigrationCheckpointInput,
  commands: PostgresBackupCommands = {}) {
  assertOnlineExpandCheckpoint(input);
  return input.sourceDatabase.transaction(async transaction => {
    const result = await transaction.raw("SELECT pg_export_snapshot() AS snapshot");
    const snapshot: unknown = result.rows?.[0]?.snapshot;
    if (typeof snapshot !== "string" || !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$/u.test(snapshot)) {
      throw Object.assign(new Error("PostgreSQL did not export a valid snapshot"), {code: "EXPAND_CHECKPOINT_SNAPSHOT_INVALID"});
    }
    const pgDump = commands.pgDump ?? {executable: "pg_dump"};
    const dumpCommands: PostgresBackupCommands = {...commands, pgDump: {...pgDump,
      prefixArgs: [...(pgDump.prefixArgs ?? []), "--snapshot", snapshot]}};
    return prepareMaintenanceMigrationCheckpoint({...input, sourceDatabase: transaction,
      dependencies: {...input.dependencies,
        createBackup: (database, config) => (input.dependencies?.createBackup ?? createBackup)(database, config, dumpCommands)}});
  }, {isolationLevel: "repeatable read", readOnly: true});
}
