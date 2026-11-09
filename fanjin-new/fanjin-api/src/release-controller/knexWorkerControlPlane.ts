import type { Knex } from "knex";

import { WORKER_HEARTBEAT_TABLE } from "@/lib/migrations/operationalRuntimeSchema";
import { WORKER_RELEASE_CONTROL_TABLE } from "@/lib/migrations/releaseDeploymentOrchestration";
import { resolveWorkerHeartbeatFutureSkewMs } from "@/lib/workerHeartbeatPolicy";
import { ReleaseInvariantError } from "./errors";
import type {
  ReleaseActionContext,
  WorkerControlPlane,
  WorkerRuntimeSnapshot,
  WorkerSchemaExpectation,
} from "./types";
import {
  decodeWorkerSchemaBridgeFence,
  encodeWorkerSchemaBridgeFence,
} from "./workerSchemaBridge";

interface WorkerHeartbeatRow {
  nodeId: string | null;
  heartbeatAt: number | string;
  artifactSha256: string | null;
  schemaVersion: number | string | null;
  acceptingWork: number | boolean | null;
  activeTaskCount: number | string | null;
  drainOperationId: string | null;
  controlRevision: number | string | null;
}

interface WorkerControlRow {
  nodeId: string;
  desiredState: "running" | "draining";
  operationId: string | null;
  revision: number | string;
}

export interface KnexWorkerControlPlaneClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const systemClock: KnexWorkerControlPlaneClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function integer(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function fail(code: string, message: string): never {
  throw new ReleaseInvariantError(code, message);
}

function assertExpectation(expectation: WorkerSchemaExpectation): void {
  if (
    !validSha(expectation.artifactSha256)
    || !Number.isSafeInteger(expectation.targetSchemaVersion)
    || expectation.targetSchemaVersion < 1
    || !Number.isSafeInteger(expectation.observedDatabaseSchemaVersion)
    || expectation.observedDatabaseSchemaVersion < 1
  ) {
    fail("WORKER_SCHEMA_EXPECTATION_INVALID", "Worker schema 期望无效");
  }
  if (expectation.runtimeMode === "migration-bridge") {
    const migration = expectation.migration;
    if (
      !migration
      || !Number.isSafeInteger(migration.fromVersion)
      || !Number.isSafeInteger(migration.toVersion)
      || migration.fromVersion >= migration.toVersion
      || !validSha(migration.compatibilityProofSha256)
      || (
        expectation.observedDatabaseSchemaVersion !== migration.fromVersion
        && expectation.observedDatabaseSchemaVersion !== migration.toVersion
      )
      || (
        expectation.targetSchemaVersion !== migration.fromVersion
        && expectation.targetSchemaVersion !== migration.toVersion
      )
    ) {
      fail("WORKER_SCHEMA_BRIDGE_EXPECTATION_INVALID", "Worker bridge schema 期望无效");
    }
  } else if (expectation.migration !== undefined) {
    fail("WORKER_SCHEMA_EXPECTATION_INVALID", "非 bridge Worker 禁止携带迁移 fence");
  }
}

/**
 * Strict DB worker admission/drain control. Exactly one fresh incarnation per
 * trusted node is required; duplicate live processes fail closed because the
 * controller cannot prove they were all drained by one node action.
 */
export class KnexWorkerControlPlane implements WorkerControlPlane {
  private readonly database: Knex;
  private readonly nodeIds: readonly string[];
  private readonly nodeSet: ReadonlySet<string>;
  private readonly heartbeatMaxAgeMs: number;
  private readonly heartbeatFutureSkewMs: number;
  private readonly drainTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: KnexWorkerControlPlaneClock;

  constructor(options: {
    database: Knex;
    nodeIds: readonly string[];
    heartbeatMaxAgeMs?: number;
    heartbeatFutureSkewMs?: number;
    drainTimeoutMs: number;
    readinessTimeoutMs: number;
    pollIntervalMs?: number;
    clock?: KnexWorkerControlPlaneClock;
  }) {
    if (!options.database) throw new TypeError("worker control database is required");
    if (options.nodeIds.length < 2 || new Set(options.nodeIds).size !== options.nodeIds.length) {
      throw new TypeError("worker control requires at least two unique nodes");
    }
    if (options.nodeIds.some((nodeId) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nodeId))) {
      throw new TypeError("worker node id format is invalid");
    }
    this.database = options.database;
    this.nodeIds = Object.freeze([...options.nodeIds]);
    this.nodeSet = new Set(this.nodeIds);
    this.heartbeatMaxAgeMs = this.positive(options.heartbeatMaxAgeMs ?? 45_000, "heartbeatMaxAgeMs");
    this.heartbeatFutureSkewMs = resolveWorkerHeartbeatFutureSkewMs(options.heartbeatFutureSkewMs);
    this.drainTimeoutMs = this.positive(options.drainTimeoutMs, "drainTimeoutMs");
    this.readinessTimeoutMs = this.positive(options.readinessTimeoutMs, "readinessTimeoutMs");
    this.pollIntervalMs = this.positive(options.pollIntervalMs ?? 2_000, "pollIntervalMs", 0);
    this.clock = options.clock ?? systemClock;
  }

  async listWorkers(_context: ReleaseActionContext): Promise<readonly WorkerRuntimeSnapshot[]> {
    return this.listWorkersFrom(this.database);
  }

  private async listWorkersFrom(
    database: Knex | Knex.Transaction,
    lockRows = false,
  ): Promise<readonly WorkerRuntimeSnapshot[]> {
    const now = this.clock.now();
    const query = database<WorkerHeartbeatRow>(WORKER_HEARTBEAT_TABLE)
      .where({ role: "background" })
      .where("heartbeatAt", ">=", now - this.heartbeatMaxAgeMs)
      .select(
        "nodeId",
        "heartbeatAt",
        "artifactSha256",
        "schemaVersion",
        "acceptingWork",
        "activeTaskCount",
        "drainOperationId",
        "controlRevision",
      );
    if (lockRows) query.forUpdate();
    const rows = await query;
    const futureHeartbeat = rows.find((row) => {
      const heartbeatAt = integer(row.heartbeatAt);
      return heartbeatAt !== null && heartbeatAt > now + this.heartbeatFutureSkewMs;
    });
    if (futureHeartbeat) {
      fail("WORKER_HEARTBEAT_FROM_FUTURE", "发现时间戳超前的在线 Worker");
    }
    // Query every fresh background incarnation, including legacy/misconfigured
    // rows without a nodeId. Ignoring those rows would let a live Worker keep
    // claiming jobs while completely bypassing the trusted release inventory.
    const unexpected = rows.find((row) => !row.nodeId || !this.nodeSet.has(String(row.nodeId)));
    if (unexpected) {
      fail("WORKER_INVENTORY_UNTRACKED_LIVE_NODE", "发现不在受信清单中的在线 Worker");
    }
    const grouped = new Map<string, WorkerHeartbeatRow[]>();
    for (const row of rows) {
      const nodeId = String(row.nodeId);
      grouped.set(nodeId, [...(grouped.get(nodeId) || []), row]);
    }
    return this.nodeIds.map((nodeId) => this.snapshot(nodeId, grouped.get(nodeId) || []));
  }

  async assertHealthyCapacity(
    excludedNodeId: string,
    minimumHealthy: number,
    context: ReleaseActionContext,
  ): Promise<void> {
    if (!this.nodeSet.has(excludedNodeId)) fail("WORKER_NODE_UNKNOWN", "Worker 不在受信清单中");
    const snapshots = await this.listWorkers(context);
    const target = snapshots.find((snapshot) => snapshot.nodeId === excludedNodeId)!;
    if (!target.healthy || !target.acceptingWork) {
      fail("WORKER_TARGET_NOT_HEALTHY", `Worker ${excludedNodeId} 摘除前并非健康接单状态`);
    }
    const healthyPeers = snapshots.filter((snapshot) => (
      snapshot.nodeId !== excludedNodeId && snapshot.healthy && snapshot.acceptingWork
    )).length;
    if (healthyPeers < minimumHealthy) {
      fail("INSUFFICIENT_HEALTHY_WORKERS", `Worker ${excludedNodeId} 摘除后健康容量不足`);
    }
  }

  async requestDrain(nodeId: string, context: ReleaseActionContext): Promise<void> {
    this.assertNode(nodeId);
    await this.database.transaction(async (trx) => {
      const current = await trx<WorkerControlRow>(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId })
        .forUpdate()
        .first();
      const now = this.clock.now();
      if (!current) {
        await trx(WORKER_RELEASE_CONTROL_TABLE).insert({
          nodeId,
          desiredState: "draining",
          operationId: context.operationId,
          requestedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        return;
      }
      const revision = integer(current.revision);
      if (revision === null) fail("WORKER_CONTROL_CORRUPT", "Worker 控制记录 revision 无效");
      if (current.desiredState === "draining") {
        const bridge = decodeWorkerSchemaBridgeFence(current.operationId);
        if (current.operationId === context.operationId) return;
        if (bridge?.operationId !== context.operationId) {
          fail("WORKER_DRAIN_OWNED_BY_OTHER_OPERATION", `Worker ${nodeId} 已被其他发布排空`);
        }
        const updated = await trx(WORKER_RELEASE_CONTROL_TABLE)
          .where({ nodeId, revision, operationId: current.operationId })
          .update({
            operationId: context.operationId,
            requestedAt: now,
            revision: revision + 1,
            updatedAt: now,
          });
        if (Number(updated) !== 1) {
          fail("WORKER_CONTROL_CONFLICT", "Worker bridge 转排空发生并发冲突");
        }
        return;
      }
      const updated = await trx(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId, revision })
        .update({
          desiredState: "draining",
          operationId: context.operationId,
          requestedAt: now,
          revision: revision + 1,
          updatedAt: now,
        });
      if (Number(updated) !== 1) fail("WORKER_CONTROL_CONFLICT", "Worker 排空控制发生并发冲突");
    });
  }

  /**
   * Atomically transfers every trusted Worker control row to one drain
   * operation. This is intentionally separate from rolling `requestDrain`:
   * all-fleet maintenance cannot retain a healthy peer, but it must never
   * leave only part of the fleet fenced if another operation owns one row.
   */
  async requestFleetDrain(context: ReleaseActionContext): Promise<void> {
    if (!validSha(context.artifactSha256)) {
      fail("WORKER_FLEET_DRAIN_CONTEXT_INVALID", "Worker fleet 排空制品身份无效");
    }
    await this.database.transaction(async (trx) => {
      // Lock the live Worker incarnations first. Besides keeping this
      // preflight stable until commit, this serializes same-fleet callers even
      // if the release-control rows have not been bootstrapped yet.
      const snapshots = await this.listWorkersFrom(trx, true);
      const snapshotByNode = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot]));
      const currentRows = await trx<WorkerControlRow>(WORKER_RELEASE_CONTROL_TABLE)
        .whereIn("nodeId", this.nodeIds)
        .orderBy("nodeId", "asc")
        .forUpdate();
      const currentByNode = new Map(currentRows.map((row) => [row.nodeId, row]));
      const now = this.clock.now();
      const mutations: Array<{
        nodeId: string;
        current: WorkerControlRow | null;
        revision: number;
      }> = [];

      // Validate the complete fleet before issuing the first write. The
      // transaction then makes the control transfer all-or-nothing.
      for (const nodeId of this.nodeIds) {
        const snapshot = snapshotByNode.get(nodeId)!;
        if (!snapshot.healthy) {
          fail("WORKER_FLEET_NODE_NOT_HEALTHY", `Worker ${nodeId} fleet 排空前并非健康状态`);
        }
        if (snapshot.artifactSha256 !== context.artifactSha256) {
          fail("WORKER_FLEET_ARTIFACT_MISMATCH", `Worker ${nodeId} 不属于待排空制品`);
        }
        const current = currentByNode.get(nodeId) || null;
        if (!current) {
          if (!snapshot.acceptingWork) {
            fail("WORKER_FLEET_NODE_NOT_ACCEPTING", `Worker ${nodeId} 缺少可接管的运行控制状态`);
          }
          mutations.push({ nodeId, current: null, revision: 0 });
          continue;
        }
        const revision = integer(current.revision);
        if (revision === null) {
          fail("WORKER_CONTROL_CORRUPT", `Worker ${nodeId} 控制记录 revision 无效`);
        }
        if (current.desiredState === "draining") {
          const bridge = decodeWorkerSchemaBridgeFence(current.operationId);
          if (current.operationId === context.operationId) continue;
          if (bridge?.operationId !== context.operationId) {
            fail("WORKER_DRAIN_OWNED_BY_OTHER_OPERATION", `Worker ${nodeId} 已被其他发布排空`);
          }
          mutations.push({ nodeId, current, revision });
          continue;
        }
        if (current.desiredState !== "running" || current.operationId !== null) {
          fail("WORKER_CONTROL_CORRUPT", `Worker ${nodeId} 控制状态无效`);
        }
        if (!snapshot.acceptingWork) {
          fail("WORKER_FLEET_NODE_NOT_ACCEPTING", `Worker ${nodeId} fleet 排空前未接单`);
        }
        mutations.push({ nodeId, current, revision });
      }

      for (const mutation of mutations) {
        if (!mutation.current) {
          await trx(WORKER_RELEASE_CONTROL_TABLE).insert({
            nodeId: mutation.nodeId,
            desiredState: "draining",
            operationId: context.operationId,
            requestedAt: now,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          continue;
        }
        const updated = await trx(WORKER_RELEASE_CONTROL_TABLE)
          .where({
            nodeId: mutation.nodeId,
            desiredState: mutation.current.desiredState,
            operationId: mutation.current.operationId,
            revision: mutation.revision,
          })
          .update({
            desiredState: "draining",
            operationId: context.operationId,
            requestedAt: now,
            revision: mutation.revision + 1,
            updatedAt: now,
          });
        if (Number(updated) !== 1) {
          fail("WORKER_CONTROL_CONFLICT", "Worker fleet 排空控制发生并发冲突");
        }
      }
    });
  }

  async waitForDrained(nodeId: string, context: ReleaseActionContext): Promise<WorkerRuntimeSnapshot> {
    return this.waitFor(nodeId, this.drainTimeoutMs, "WORKER_DRAIN_TIMEOUT", async () => {
      const { snapshot, control } = await this.readNode(nodeId, context);
      if (control?.desiredState !== "draining" || control.operationId !== context.operationId) {
        fail("WORKER_DRAIN_CONTROL_LOST", `Worker ${nodeId} 排空控制权已丢失`);
      }
      if (!snapshot.healthy) return null;
      return !snapshot.acceptingWork
        && snapshot.activeTaskCount === 0
        && snapshot.drainOperationId === context.operationId
        ? snapshot
        : null;
    });
  }

  async waitForArtifact(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<WorkerRuntimeSnapshot> {
    assertExpectation(expectation);
    if (expectation.runtimeMode !== "isolated") {
      fail("WORKER_SCHEMA_EXPECTATION_INVALID", "版本验活必须要求 Worker 保持隔离");
    }
    return this.waitFor(nodeId, this.readinessTimeoutMs, "WORKER_ARTIFACT_TIMEOUT", async () => {
      const { snapshot, control } = await this.readNode(nodeId, context);
      if (control?.desiredState !== "draining" || control.operationId !== context.operationId) {
        fail("WORKER_DRAIN_CONTROL_LOST", `Worker ${nodeId} 版本校验期间不再排空`);
      }
      if (!snapshot.healthy) return null;
      if (snapshot.acceptingWork || snapshot.activeTaskCount !== 0) {
        fail("WORKER_ACCEPTING_DURING_VERIFY", `Worker ${nodeId} 在版本校验期间接单`);
      }
      return snapshot.artifactSha256 === expectation.artifactSha256
        && snapshot.observedDatabaseSchemaVersion
          === expectation.observedDatabaseSchemaVersion
        && snapshot.schemaRuntimeMode === "isolated"
        ? snapshot
        : null;
    });
  }

  async authorizeSchemaBridge(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<void> {
    this.assertNode(nodeId);
    assertExpectation(expectation);
    if (expectation.runtimeMode !== "migration-bridge" || !expectation.migration) {
      fail("WORKER_SCHEMA_BRIDGE_EXPECTATION_INVALID", "Worker bridge 授权缺少迁移合同");
    }
    const fence = encodeWorkerSchemaBridgeFence({
      operationId: context.operationId,
      artifactSha256: expectation.artifactSha256,
      artifactSchemaVersion: expectation.targetSchemaVersion,
      fromVersion: expectation.migration.fromVersion,
      toVersion: expectation.migration.toVersion,
      compatibilityProofSha256:
        expectation.migration.compatibilityProofSha256,
    });
    await this.database.transaction(async (trx) => {
      const current = await trx<WorkerControlRow>(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId })
        .forUpdate()
        .first();
      if (!current) {
        fail("WORKER_CONTROL_MISSING", `Worker ${nodeId} 缺少控制记录`);
      }
      const existingFence = decodeWorkerSchemaBridgeFence(current.operationId);
      if (existingFence && current.operationId === fence) return;
      if (
        !(
          (current.desiredState === "running" && current.operationId === null)
          || (
            current.desiredState === "draining"
            && current.operationId === context.operationId
          )
        )
      ) {
        fail("WORKER_SCHEMA_BRIDGE_CONTROL_CONFLICT", `Worker ${nodeId} bridge 控制权冲突`);
      }
      const revision = integer(current.revision);
      if (revision === null) fail("WORKER_CONTROL_CORRUPT", "Worker 控制记录 revision 无效");
      const updated = await trx(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId, revision })
        .update({
          // The existing source-schema CHECK permits this state. Runtime
          // admission distinguishes the signed fence from an ordinary drain.
          desiredState: "draining",
          operationId: fence,
          requestedAt: this.clock.now(),
          revision: revision + 1,
          updatedAt: this.clock.now(),
        });
      if (Number(updated) !== 1) {
        fail("WORKER_CONTROL_CONFLICT", "Worker bridge 授权发生并发冲突");
      }
    });
  }

  async resume(nodeId: string, context: ReleaseActionContext): Promise<void> {
    this.assertNode(nodeId);
    await this.database.transaction(async (trx) => {
      const current = await trx<WorkerControlRow>(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId })
        .forUpdate()
        .first();
      const bridge = decodeWorkerSchemaBridgeFence(current?.operationId);
      if (
        !current
        || current.desiredState !== "draining"
        || (
          current.operationId !== context.operationId
          && bridge?.operationId !== context.operationId
        )
      ) {
        fail("WORKER_DRAIN_CONTROL_LOST", `Worker ${nodeId} 无法由当前发布恢复接单`);
      }
      const revision = integer(current.revision);
      if (revision === null) fail("WORKER_CONTROL_CORRUPT", "Worker 控制记录 revision 无效");
      const updated = await trx(WORKER_RELEASE_CONTROL_TABLE)
        .where({ nodeId, revision, operationId: current.operationId })
        .update({
          desiredState: "running",
          operationId: null,
          requestedAt: null,
          revision: revision + 1,
          updatedAt: this.clock.now(),
        });
      if (Number(updated) !== 1) fail("WORKER_CONTROL_CONFLICT", "Worker 恢复接单发生并发冲突");
    });
  }

  async waitForServing(
    nodeId: string,
    expectation: WorkerSchemaExpectation,
    context: ReleaseActionContext,
  ): Promise<WorkerRuntimeSnapshot> {
    assertExpectation(expectation);
    if (expectation.runtimeMode === "isolated") {
      fail("WORKER_SCHEMA_EXPECTATION_INVALID", "接单验活不能要求隔离模式");
    }
    return this.waitFor(nodeId, this.readinessTimeoutMs, "WORKER_SERVING_TIMEOUT", async () => {
      const { snapshot, control } = await this.readNode(nodeId, context);
      const bridge = decodeWorkerSchemaBridgeFence(control?.operationId);
      const controlMatches = expectation.runtimeMode === "migration-bridge"
        ? control?.desiredState === "draining"
          && bridge?.operationId === context.operationId
          && bridge.artifactSha256 === expectation.artifactSha256
          && bridge.artifactSchemaVersion === expectation.targetSchemaVersion
          && bridge.fromVersion === expectation.migration?.fromVersion
          && bridge.toVersion === expectation.migration?.toVersion
          && bridge.compatibilityProofSha256
            === expectation.migration?.compatibilityProofSha256
        : control?.desiredState === "running" && control.operationId === null;
      if (!controlMatches) {
        fail("WORKER_RESUME_CONTROL_LOST", `Worker ${nodeId} 恢复接单控制状态无效`);
      }
      return snapshot.healthy
        && snapshot.acceptingWork
        && snapshot.artifactSha256 === expectation.artifactSha256
        && snapshot.observedDatabaseSchemaVersion
          === expectation.observedDatabaseSchemaVersion
        && snapshot.schemaRuntimeMode === expectation.runtimeMode
        && (
          expectation.runtimeMode === "migration-bridge"
            ? snapshot.bridgeOperationId === context.operationId
              && snapshot.bridgeCompatibilityProofSha256
                === expectation.migration?.compatibilityProofSha256
            : snapshot.drainOperationId === null
        )
        ? snapshot
        : null;
    });
  }

  private async readNode(nodeId: string, context: ReleaseActionContext): Promise<{
    snapshot: WorkerRuntimeSnapshot;
    control: WorkerControlRow | null;
  }> {
    this.assertNode(nodeId);
    const [snapshots, control] = await Promise.all([
      this.listWorkers(context),
      this.database<WorkerControlRow>(WORKER_RELEASE_CONTROL_TABLE).where({ nodeId }).first(),
    ]);
    return {
      snapshot: snapshots.find((entry) => entry.nodeId === nodeId)!,
      control: control || null,
    };
  }

  private snapshot(nodeId: string, rows: readonly WorkerHeartbeatRow[]): WorkerRuntimeSnapshot {
    if (rows.length !== 1) {
      return {
        nodeId,
        healthy: false,
        acceptingWork: false,
        activeTaskCount: -1,
        artifactSha256: "",
        schemaVersion: -1,
        observedDatabaseSchemaVersion: -1,
        targetSchemaVersion: null,
        schemaRuntimeMode: "isolated",
        bridgeOperationId: null,
        bridgeCompatibilityProofSha256: null,
        heartbeatAt: 0,
        drainOperationId: null,
      };
    }
    const row = rows[0];
    const heartbeatAt = integer(row.heartbeatAt);
    const schemaVersion = integer(row.schemaVersion);
    const activeTaskCount = integer(row.activeTaskCount);
    const identityValid = validSha(row.artifactSha256)
      && schemaVersion !== null
      && schemaVersion >= 0
      && activeTaskCount !== null
      && activeTaskCount >= 0
      && heartbeatAt !== null;
    const bridge = identityValid
      ? decodeWorkerSchemaBridgeFence(row.drainOperationId)
      : null;
    const acceptingWork = identityValid && boolean(row.acceptingWork);
    return {
      nodeId,
      healthy: identityValid,
      acceptingWork,
      activeTaskCount: identityValid ? activeTaskCount! : -1,
      artifactSha256: identityValid ? row.artifactSha256! : "",
      schemaVersion: identityValid ? schemaVersion! : -1,
      observedDatabaseSchemaVersion: identityValid ? schemaVersion! : -1,
      targetSchemaVersion: identityValid
        ? bridge?.artifactSchemaVersion ?? (acceptingWork ? schemaVersion! : null)
        : null,
      schemaRuntimeMode: acceptingWork
        ? bridge ? "migration-bridge" : "normal"
        : "isolated",
      bridgeOperationId: bridge?.operationId ?? null,
      bridgeCompatibilityProofSha256:
        bridge?.compatibilityProofSha256 ?? null,
      heartbeatAt: identityValid ? heartbeatAt! : 0,
      drainOperationId: identityValid && row.drainOperationId ? String(row.drainOperationId) : null,
    };
  }

  private async waitFor(
    nodeId: string,
    timeoutMs: number,
    timeoutCode: string,
    sample: () => Promise<WorkerRuntimeSnapshot | null>,
  ): Promise<WorkerRuntimeSnapshot> {
    const deadline = this.clock.now() + timeoutMs;
    while (true) {
      const result = await sample();
      if (result) return result;
      if (this.clock.now() >= deadline) fail(timeoutCode, `Worker ${nodeId} 等待状态超时`);
      await this.clock.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadline - this.clock.now())));
    }
  }

  private assertNode(nodeId: string): void {
    if (!this.nodeSet.has(nodeId)) fail("WORKER_NODE_UNKNOWN", "Worker 不在受信清单中");
  }

  private positive(value: number, label: string, minimum = 1): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} is invalid`);
    return value;
  }
}
