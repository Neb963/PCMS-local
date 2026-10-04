import type { DatabaseSync } from "node:sqlite";

const CORE_BACKUP_ID =
  /^core-[0-9]{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type RecoveryMode = "NORMAL" | "RECOVERY_HOLD";

export interface RecoveryControlState {
  readonly mode: RecoveryMode;
  readonly sourceBackupId: string | null;
  readonly enteredAt: string | null;
  readonly revision: number;
}

export interface EnterRecoveryHoldOptions {
  readonly sourceBackupId: string;
  readonly now?: () => Date;
}

export class RecoveryControlError extends Error {
  public constructor(
    public readonly code:
      | "RECOVERY_STATE_INVALID"
      | "RECOVERY_BACKUP_ID_INVALID"
      | "RECOVERY_TIME_INVALID",
    message: string
  ) {
    super(message);
    this.name = "RecoveryControlError";
  }
}

interface RecoveryRow {
  readonly mode: unknown;
  readonly source_backup_id: unknown;
  readonly entered_at: unknown;
  readonly revision: unknown;
}

function fail(
  code: RecoveryControlError["code"],
  message: string
): never {
  throw new RecoveryControlError(code, message);
}

function parseRow(row: RecoveryRow | undefined): RecoveryControlState {
  if (row === undefined) {
    fail(
      "RECOVERY_STATE_INVALID",
      "recovery control singleton is missing"
    );
  }
  if (
    (row.mode !== "NORMAL" && row.mode !== "RECOVERY_HOLD") ||
    (row.source_backup_id !== null &&
      typeof row.source_backup_id !== "string") ||
    (row.entered_at !== null &&
      typeof row.entered_at !== "string") ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail(
      "RECOVERY_STATE_INVALID",
      "recovery control state is invalid"
    );
  }
  if (
    (row.mode === "NORMAL" &&
      (row.source_backup_id !== null || row.entered_at !== null)) ||
    (row.mode === "RECOVERY_HOLD" &&
      (row.source_backup_id === null || row.entered_at === null))
  ) {
    fail(
      "RECOVERY_STATE_INVALID",
      "recovery control state violates mode invariants"
    );
  }

  return Object.freeze({
    mode: row.mode,
    sourceBackupId: row.source_backup_id,
    enteredAt: row.entered_at,
    revision: row.revision
  });
}

function currentTime(now: (() => Date) | undefined): string {
  const value = now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) {
    fail(
      "RECOVERY_TIME_INVALID",
      "recovery clock returned an invalid time"
    );
  }
  return value.toISOString();
}

export function readRecoveryControl(
  database: DatabaseSync
): RecoveryControlState {
  return parseRow(
    database.prepare(`
      SELECT
        mode,
        source_backup_id,
        entered_at,
        revision
      FROM recovery_control
      WHERE singleton = 1
    `).get() as RecoveryRow | undefined
  );
}

export function isRecoveryHeld(
  database: DatabaseSync
): boolean {
  return readRecoveryControl(database).mode === "RECOVERY_HOLD";
}

export function enterRecoveryHold(
  database: DatabaseSync,
  options: EnterRecoveryHoldOptions
): RecoveryControlState {
  if (!CORE_BACKUP_ID.test(options.sourceBackupId)) {
    fail(
      "RECOVERY_BACKUP_ID_INVALID",
      "sourceBackupId must identify a managed Core backup"
    );
  }
  const enteredAt = currentTime(options.now);
  database.prepare(`
    UPDATE recovery_control
    SET
      mode = 'RECOVERY_HOLD',
      source_backup_id = ?,
      entered_at = ?,
      revision = revision + 1
    WHERE singleton = 1
  `).run(options.sourceBackupId, enteredAt);
  return readRecoveryControl(database);
}

export function releaseRecoveryHold(
  database: DatabaseSync
): RecoveryControlState {
  database.prepare(`
    UPDATE recovery_control
    SET
      mode = 'NORMAL',
      source_backup_id = NULL,
      entered_at = NULL,
      revision = revision + 1
    WHERE singleton = 1
  `).run();
  return readRecoveryControl(database);
}
