import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ReleaseCheckpoint, ReleaseStore } from "./types";

function fail(code: string, message: string, cause?: unknown): never {
  throw Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function cloneCheckpoint(checkpoint: ReleaseCheckpoint): ReleaseCheckpoint {
  return structuredClone(checkpoint);
}

/**
 * Crash-resumable store used only by the one-shot first-baseline rollout.
 *
 * The normal Controller persists checkpoints in PostgreSQL. Before the first
 * ledger baseline exists there is deliberately no deployment row to claim, so
 * this store provides the same optimistic revision contract in a private,
 * host-local file without inventing false deployment provenance.
 */
export class BaselineRolloutFileStore implements ReleaseStore {
  readonly filePath: string;
  private readonly operationId: string;

  constructor(input: {
    releaseId: string;
    operationId: string;
    filePath?: string;
  }) {
    this.filePath = input.filePath
      || `/var/lib/fanjin-release-controller/baseline-rollout-${input.releaseId}.json`;
    this.operationId = input.operationId;
    if (!path.isAbsolute(this.filePath)) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_FILE_UNSAFE",
        "baseline rollout state file must be absolute",
      );
    }
    const parentMetadata = fs.lstatSync(path.dirname(this.filePath));
    const expectedUid = typeof process.geteuid === "function"
      ? process.geteuid()
      : parentMetadata.uid;
    if (
      parentMetadata.isSymbolicLink()
      || !parentMetadata.isDirectory()
      || parentMetadata.uid !== expectedUid
      || (parentMetadata.mode & 0o022) !== 0
    ) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_FILE_UNSAFE",
        "baseline rollout state directory is unsafe",
      );
    }
  }

  private read(): ReleaseCheckpoint | null {
    if (!fs.existsSync(this.filePath)) return null;
    const before = fs.lstatSync(this.filePath);
    const expectedUid = typeof process.geteuid === "function"
      ? process.geteuid()
      : before.uid;
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600
      || before.size < 1
      || before.size > 8 * 1024 * 1024
    ) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_FILE_UNSAFE",
        "baseline rollout state file is unsafe",
      );
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number"
      ? fs.constants.O_NOFOLLOW
      : 0;
    const descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_RDONLY | noFollow,
    );
    let raw: string;
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.uid !== expectedUid
        || (opened.mode & 0o777) !== 0o600
        || opened.size !== before.size
      ) {
        fail(
          "RELEASE_BASELINE_ROLLOUT_STATE_FILE_UNSAFE",
          "baseline rollout state changed during read",
        );
      }
      raw = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    let parsed: ReleaseCheckpoint;
    try {
      parsed = JSON.parse(raw) as ReleaseCheckpoint;
    } catch (error) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_INVALID",
        "baseline rollout state is not valid JSON",
        error,
      );
    }
    if (
      !parsed
      || parsed.operationId !== this.operationId
      || !Number.isSafeInteger(parsed.revision)
      || parsed.revision < 1
    ) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_INVALID",
        "baseline rollout state identity is invalid",
      );
    }
    return parsed;
  }

  private write(
    checkpoint: ReleaseCheckpoint,
    expectedRevision: number | null,
  ): ReleaseCheckpoint {
    const parent = path.dirname(this.filePath);
    const lockPath = `${this.filePath}.lock`;
    let lockDescriptor: number;
    try {
      lockDescriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      fail(
        "RELEASE_BASELINE_ROLLOUT_STATE_CONFLICT",
        "baseline rollout state is locked",
        error,
      );
    }
    try {
      fs.writeFileSync(lockDescriptor, `${process.pid}\n`, "utf8");
      fs.fsyncSync(lockDescriptor);
    } finally {
      fs.closeSync(lockDescriptor);
    }

    const temporary = path.join(
      parent,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      const current = this.read();
      if (expectedRevision === null) {
        if (current) {
          fail(
            "RELEASE_BASELINE_ROLLOUT_STATE_CONFLICT",
            "baseline rollout state already exists",
          );
        }
      } else if (!current || current.revision !== expectedRevision) {
        fail(
          "RELEASE_BASELINE_ROLLOUT_STATE_CONFLICT",
          "baseline rollout state revision conflict",
        );
      }
      const saved = {
        ...cloneCheckpoint(checkpoint),
        revision: expectedRevision === null ? 1 : expectedRevision + 1,
      };
      const descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(saved)}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, this.filePath);
      const directory = fs.openSync(parent, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      return cloneCheckpoint(saved);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        fs.unlinkSync(lockPath);
      }
    }
  }

  async get(operationId: string): Promise<ReleaseCheckpoint | null> {
    if (operationId !== this.operationId) return null;
    const checkpoint = this.read();
    return checkpoint ? cloneCheckpoint(checkpoint) : null;
  }

  async create(checkpoint: ReleaseCheckpoint): Promise<ReleaseCheckpoint> {
    if (checkpoint.operationId !== this.operationId) {
      throw new Error("baseline rollout operation identity mismatch");
    }
    return this.write(checkpoint, null);
  }

  async save(
    checkpoint: ReleaseCheckpoint,
    expectedRevision: number,
  ): Promise<ReleaseCheckpoint> {
    if (checkpoint.operationId !== this.operationId) {
      throw new Error("baseline rollout operation identity mismatch");
    }
    return this.write(checkpoint, expectedRevision);
  }
}
