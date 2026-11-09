import type { Knex } from "knex";

const SCHEMA_MIGRATION_TABLE = "o_schema_migration";

export interface ReleaseSchema40AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

/**
 * Immutable migration identity manifest for the native 0.0.8 schema.  Keeping
 * this read-only manifest separate from databaseMigrations means a formal
 * credential readback never loads migration implementations or application
 * database startup code.  The migration suite cross-checks this manifest
 * against DATABASE_MIGRATIONS so a future identity change fails in CI.
 */
export const RELEASE_SCHEMA_40_MIGRATION_HISTORY = Object.freeze([
  Object.freeze({ version: 1, name: "legacy_init_and_fix_baseline", checksum: "638d35aa5664fb5a15e9d41f44208ae1401b99eaa28e8266c632376ae3c6fdc4" }),
  Object.freeze({ version: 2, name: "relay_callback_secret_envelope", checksum: "144a4da0a58d3d5885b2bced8fc6763eb9e63a6fb3728f709bc10f5b04989120" }),
  Object.freeze({ version: 3, name: "auth_login_state", checksum: "d668b73bacde770c38c57e3c8dcf112f7cef936754516f7ad4f34c5d04314928" }),
  Object.freeze({ version: 4, name: "user_password_history_policy", checksum: "39dd77daed63fbf00385152c63b4fb92e1e92ae5f5a4c213ea392406b6bcd554" }),
  Object.freeze({ version: 5, name: "remove_vendor_secret_logging", checksum: "a6035fa81da8cd3a63727fb67c9f11e81443ebde85edbaad8cb311fe55ad9068" }),
  Object.freeze({ version: 6, name: "retention_cleanup_indexes", checksum: "624ac747a10929148a4d5be8b3af687254a2a497c7eac78db372167b78fd3557" }),
  Object.freeze({ version: 7, name: "mfa_totp", checksum: "66ed955417e9dac15a047546aa3add8b2c77d61ee0387840a8820654fffeec86" }),
  Object.freeze({ version: 8, name: "creation_session", checksum: "d3d8bebcbdedba5aa503d6dc4d95ebe61fda60a439891a06ccb99b64e35a63e3" }),
  Object.freeze({ version: 9, name: "agent_role_config", checksum: "7ba99ddecd4e88f737b58821f7e9bd498bd07e41a117b8060ffd761a09d548c9" }),
  Object.freeze({ version: 10, name: "agent_approval_delegation", checksum: "f47353bc03894e15292851a80343e7b324772321d84d2635b5c473c609db7267" }),
  Object.freeze({ version: 11, name: "project_revision", checksum: "5b51225878cdf62222ebb3347e518f433b4d0fb7b355679fc407ba19708ce2da" }),
  Object.freeze({ version: 12, name: "creation_session_mutation", checksum: "a4ee8292e0adb6bbf998007723279413141a192197a901e43212f6716f44ac5a" }),
  Object.freeze({ version: 13, name: "agent_generation_quote", checksum: "c19f90506e55fec327afbc5b8ae7206bb1653905244a890ef4c9a10193ba3858" }),
  Object.freeze({ version: 14, name: "agent_run_recovery_count", checksum: "7da4901f678d8d1d87b689dde1c725422b66619520ef1b286a35f6db9520be25" }),
  Object.freeze({ version: 15, name: "agent_approval_consumed_step", checksum: "ac2558ced91fe5032f5caf7e6c5bf8ffafc1307f0543cb81dc0549b83993144f" }),
  Object.freeze({ version: 16, name: "agent_delegation_task_result", checksum: "65b9bb867ba03d6c7c2bd2a5aa3757eac1285aa32dabfa819760d4457b5528e7" }),
  Object.freeze({ version: 17, name: "agent_review_report", checksum: "91873ce736da5fbcb3fdfd71d74bfd24c191f64da1c64ce0f553d4d050f241bc" }),
  Object.freeze({ version: 18, name: "canvas_command_mutation", checksum: "223d116a34f5c14e2784125e68154adca3f7db901050eb9f62eb18e00a53b53a" }),
  Object.freeze({ version: 19, name: "operational_runtime_schema", checksum: "15b13e094eeffadc6d70b3cbaabc2675045afbc12839501f52587d90ef2237aa" }),
  Object.freeze({ version: 20, name: "responses_resource_binding", checksum: "8d86c441b8b5a05298e66bbb2312b16e0ce440d93bb221ed59a75a7fb6e33c78" }),
  Object.freeze({ version: 21, name: "platform_release", checksum: "fca0b93b338955f76d064f12856048b207eeb38f9324186e20d5a227cd3717d0" }),
  Object.freeze({ version: 22, name: "email_verified_at", checksum: "632ca3a0be9443c34391511a6a1a395f4c3d0c460f004b136db7ca096c841369" }),
  Object.freeze({ version: 23, name: "unified_project_canvas", checksum: "ace524d5b20a559b46fe87fc1a509b58cd7048b060fd1cd4a1e51f8f55553aca" }),
  Object.freeze({ version: 24, name: "enforce_unified_project_canvas", checksum: "76759b8afd6e3ba90d55284f5104121accb545da11191dda1465351143eb9178" }),
  Object.freeze({ version: 25, name: "agent_approval_arguments_summary", checksum: "4ca4a9fff4c8b9b6deebc3d6be3345de7080d5680d5a4320f05d5b1815cb61ab" }),
  Object.freeze({ version: 26, name: "agent_project_budget", checksum: "7a99acaf0c102530570d588d8cf5b51f215f5ca15286835c710b1567868fefda" }),
  Object.freeze({ version: 27, name: "agent_generation_review", checksum: "1495c2ef8d134a6a52176b42b1bf622153ac6655a072b1eb1ac8d3cffc00770d" }),
  Object.freeze({ version: 28, name: "canvas_asset", checksum: "db436b222431702cedb37c5894dd52232e2d6c0871c4a37c35f16cec50ee05ee" }),
  Object.freeze({ version: 29, name: "user_oauth_identity", checksum: "60a398fb4c6252f9251deb3b656cc6ff93f0bf743fec78a2cea6ab3be5560bb1" }),
  Object.freeze({ version: 30, name: "model_route_display_name", checksum: "351c6b58912bcabe50b03daf5b098284a8b272073bdd923c6c4c4f924ae0c62f" }),
  Object.freeze({ version: 31, name: "video_fulfillment_recipe", checksum: "54be2f0ed535d352eea05f34e12a9e8542b51fbe281b869528bb822da697826d" }),
  Object.freeze({ version: 32, name: "user_video_enhance_task", checksum: "ec5824813fce32bfce9518e99f9f5f186020e2421b9005c9c382b617fb7db1c1" }),
  Object.freeze({ version: 33, name: "release_deployment_orchestration", checksum: "463a41991fc873ac32262727e4f023f7ef6528a8022cecfeeee2a7f37c181ce6" }),
  Object.freeze({ version: 34, name: "release_deployment_reconciliation", checksum: "00643dcefee4ecc8ff5aba680276e02e1e9e78d7118522116b7d0ed4e6ecb247" }),
  Object.freeze({ version: 35, name: "deletion_workflow", checksum: "d06a018583d7e3ab04b4c8c5814dda0cbe4e680d09e105659028bc14f6ad55f4" }),
  Object.freeze({ version: 36, name: "release_artifact_generation", checksum: "7b499fb7ab78c1970461f8e8a0e90fb70902e1a2fb5d2e17abdf4efd439a7495" }),
  Object.freeze({ version: 37, name: "active_project_trigger_row_shape_repair", checksum: "eb9f83b2a3595b6df7420f8e7b499432e99d7194520d13d9a03f7a1e283e6362" }),
  Object.freeze({ version: 38, name: "identity_authority_integrity", checksum: "a228abdaa1a0fd1dc7f57c950b74eefd637dd996eb705c8a3dfb9357c41317fe" }),
  Object.freeze({ version: 39, name: "service_request_v1_runtime", checksum: "2e060f342fb8882c93c8d57c92841a7b02f8630ca449282192dfa3ad10311cc3" }),
  Object.freeze({ version: 40, name: "project_folders", checksum: "169817a25ff2d1d64aa9de29ed9701aef92fa8b4fe13f7939ca7773ba4e32688" }),
]) as readonly Readonly<{
  version: number;
  name: string;
  checksum: string;
}>[];

export async function inspectReleaseSchema40ReadOnly(
  database: Knex | Knex.Transaction,
): Promise<Readonly<{
  tableExists: boolean;
  current: boolean;
  applied: ReleaseSchema40AppliedMigration[];
  databaseVersion: number;
  knownLatestVersion: 40;
}>> {
  const tableExists = await database.schema.hasTable(SCHEMA_MIGRATION_TABLE);
  if (!tableExists) {
    return Object.freeze({
      tableExists: false,
      current: false,
      applied: [],
      databaseVersion: 0,
      knownLatestVersion: 40 as const,
    });
  }

  const rows = await database(SCHEMA_MIGRATION_TABLE)
    .select("version", "name", "checksum", "appliedAt")
    .orderBy("version", "asc");
  const applied = rows.map((row: Record<string, unknown>) => ({
    version: Number(row.version),
    name: String(row.name || ""),
    checksum: String(row.checksum || ""),
    appliedAt: Number(row.appliedAt),
  }));
  const current = applied.length === RELEASE_SCHEMA_40_MIGRATION_HISTORY.length
    && applied.every((row, index) => {
      const expected = RELEASE_SCHEMA_40_MIGRATION_HISTORY[index];
      return Number.isSafeInteger(row.appliedAt)
        && row.appliedAt >= 0
        && row.version === expected.version
        && row.name === expected.name
        && row.checksum === expected.checksum;
    });
  return Object.freeze({
    tableExists: true,
    current,
    applied,
    databaseVersion: applied.at(-1)?.version || 0,
    knownLatestVersion: 40 as const,
  });
}
