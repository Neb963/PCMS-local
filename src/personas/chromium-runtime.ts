import { readFile, readlink, realpath } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export type ChromiumRuntimeState = "STARTING" | "RUNNING" | "DEGRADED";

export interface ChromiumProcessFingerprint {
  readonly pid: number;
  readonly processStartTicks: string;
  readonly executableRealPath: string;
  readonly profilePath: string;
}

export interface ChromiumRuntimeRecord {
  readonly personaUid: string;
  readonly state: ChromiumRuntimeState;
  readonly pid: number | null;
  readonly processStartTicks: string | null;
  readonly executablePath: string | null;
  readonly executableRealPath: string | null;
  readonly browserVersion: string | null;
  readonly devToolsPort: number | null;
  readonly devToolsPath: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastError: string | null;
}

export type ChromiumProcessOwnership = "OWNED" | "GONE" | "MISMATCH";

interface ChromiumRuntimeRow {
  readonly persona_uid: unknown;
  readonly state: unknown;
  readonly pid: unknown;
  readonly process_start_ticks: unknown;
  readonly executable_path: unknown;
  readonly executable_real_path: unknown;
  readonly browser_version: unknown;
  readonly devtools_port: unknown;
  readonly devtools_path: unknown;
  readonly started_at: unknown;
  readonly updated_at: unknown;
  readonly last_error: unknown;
}

const MAX_RUNTIME_ERROR_LENGTH = 512;

function systemErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function parseRuntimeRow(
  row: ChromiumRuntimeRow | undefined
): ChromiumRuntimeRecord | null {
  if (row === undefined) {
    return null;
  }

  const personaUid = row.persona_uid;
  const state = row.state;
  const pid = row.pid;
  const processStartTicks = row.process_start_ticks;
  const executablePath = row.executable_path;
  const executableRealPath = row.executable_real_path;
  const browserVersion = row.browser_version;
  const devToolsPort = row.devtools_port;
  const devToolsPath = row.devtools_path;
  const startedAt = row.started_at;
  const updatedAt = row.updated_at;
  const lastError = row.last_error;

  if (
    typeof personaUid !== "string" ||
    (state !== "STARTING" && state !== "RUNNING" && state !== "DEGRADED") ||
    (pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)) ||
    (processStartTicks !== null && typeof processStartTicks !== "string") ||
    (executablePath !== null && typeof executablePath !== "string") ||
    (executableRealPath !== null && typeof executableRealPath !== "string") ||
    (browserVersion !== null && typeof browserVersion !== "string") ||
    (devToolsPort !== null &&
      (typeof devToolsPort !== "number" ||
        !Number.isSafeInteger(devToolsPort) ||
        devToolsPort < 1 ||
        devToolsPort > 65_535)) ||
    (devToolsPath !== null && typeof devToolsPath !== "string") ||
    typeof startedAt !== "string" ||
    typeof updatedAt !== "string" ||
    (lastError !== null && typeof lastError !== "string")
  ) {
    throw new Error("Chromium runtime metadata in SQLite is invalid");
  }

  return Object.freeze({
    personaUid,
    state,
    pid,
    processStartTicks,
    executablePath,
    executableRealPath,
    browserVersion,
    devToolsPort,
    devToolsPath,
    startedAt,
    updatedAt,
    lastError
  });
}

function parseProcessStartTicks(stat: string): string {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) {
    throw new Error("Linux /proc stat payload is malformed");
  }
  const fields = stat.slice(closeParen + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
    throw new Error("Linux /proc stat payload omitted process start time");
  }
  return startTicks;
}

function parseCmdline(content: Buffer): readonly string[] {
  const entries = content
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
  if (entries.length > 1 || !entries[0]?.includes(" ")) {
    return Object.freeze(entries);
  }
  // Chromium rewrites its Linux process title so the whole command line
  // surfaces in /proc/<pid>/cmdline as one space-joined entry.
  return Object.freeze(
    entries[0].split(" ").filter((entry) => entry !== "")
  );
}

function hasOwnedProfileArgument(
  args: readonly string[],
  profilePath: string,
  rawTitle: string | null
): boolean {
  const flag = `--user-data-dir=${profilePath}`;
  if (args.includes(flag)) {
    return true;
  }
  if (rawTitle === null) {
    return false;
  }
  // The space-joined title form cannot express a profile path containing a
  // space as a single token; match it with token boundaries instead so a
  // longer sibling path can never satisfy the check by prefix.
  return (
    rawTitle === flag ||
    rawTitle.startsWith(`${flag} `) ||
    rawTitle.includes(` ${flag} `) ||
    rawTitle.endsWith(` ${flag}`)
  );
}

async function readProcessEvidence(pid: number): Promise<{
  readonly processStartTicks: string;
  readonly executableRealPath: string;
  readonly args: readonly string[];
  readonly rawTitle: string | null;
}> {
  const [stat, executableRealPath, cmdline] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/exe`),
    readFile(`/proc/${pid}/cmdline`)
  ]);
  const rawEntries = cmdline
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
  const soleEntry = rawEntries.length === 1 ? rawEntries[0] : undefined;
  const rawTitle =
    soleEntry !== undefined && soleEntry.includes(" ")
      ? soleEntry
      : null;
  return Object.freeze({
    processStartTicks: parseProcessStartTicks(stat),
    executableRealPath,
    args: parseCmdline(cmdline),
    rawTitle
  });
}

export async function captureChromiumProcessFingerprint(
  pid: number,
  executablePath: string,
  profilePath: string
): Promise<ChromiumProcessFingerprint> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("Chromium PID must be a positive safe integer");
  }

  const [configuredExecutable, canonicalProfile, observed] = await Promise.all([
    realpath(executablePath),
    realpath(profilePath),
    readProcessEvidence(pid)
  ]);

  if (
    observed.executableRealPath !== configuredExecutable ||
    !hasOwnedProfileArgument(observed.args, canonicalProfile, observed.rawTitle)
  ) {
    throw new Error(
      "Spawned Chromium process does not match the configured executable/profile ownership evidence"
    );
  }

  return Object.freeze({
    pid,
    processStartTicks: observed.processStartTicks,
    executableRealPath: configuredExecutable,
    profilePath: canonicalProfile
  });
}

export async function inspectChromiumProcessOwnership(
  fingerprint: ChromiumProcessFingerprint
): Promise<ChromiumProcessOwnership> {
  try {
    process.kill(fingerprint.pid, 0);
  } catch (error: unknown) {
    if (systemErrorCode(error) === "ESRCH") {
      return "GONE";
    }
    if (systemErrorCode(error) !== "EPERM") {
      throw error;
    }
  }

  try {
    const observed = await readProcessEvidence(fingerprint.pid);
    if (
      observed.processStartTicks !== fingerprint.processStartTicks ||
      observed.executableRealPath !== fingerprint.executableRealPath ||
      !hasOwnedProfileArgument(
        observed.args,
        fingerprint.profilePath,
        observed.rawTitle
      )
    ) {
      return "MISMATCH";
    }
    return "OWNED";
  } catch (error: unknown) {
    if (systemErrorCode(error) === "ENOENT" || systemErrorCode(error) === "ESRCH") {
      return "GONE";
    }
    throw error;
  }
}

export class ChromiumRuntimeRegistry {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(database: DatabaseSync, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  public get(personaUid: string): ChromiumRuntimeRecord | null {
    return parseRuntimeRow(
      this.#database.prepare(`
        SELECT
          persona_uid,
          state,
          pid,
          process_start_ticks,
          executable_path,
          executable_real_path,
          browser_version,
          devtools_port,
          devtools_path,
          started_at,
          updated_at,
          last_error
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get(personaUid) as ChromiumRuntimeRow | undefined
    );
  }

  public list(): readonly ChromiumRuntimeRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        persona_uid,
        state,
        pid,
        process_start_ticks,
        executable_path,
        executable_real_path,
        browser_version,
        devtools_port,
        devtools_path,
        started_at,
        updated_at,
        last_error
      FROM persona_browser_runtime
      ORDER BY persona_uid
    `).all() as unknown as ChromiumRuntimeRow[];

    return Object.freeze(
      rows.map((row) => {
        const parsed = parseRuntimeRow(row);
        if (parsed === null) {
          throw new Error("Chromium runtime row unexpectedly disappeared");
        }
        return parsed;
      })
    );
  }

  public countActive(): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM persona_browser_runtime
      WHERE state IN ('STARTING', 'RUNNING', 'DEGRADED')
    `).get();
    const count = row?.["count"];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Chromium runtime active count is invalid");
    }
    return count;
  }

  public begin(
    personaUid: string,
    executablePath: string,
    browserVersion: string
  ): ChromiumRuntimeRecord {
    const now = this.#now().toISOString();
    const result = this.#database.prepare(`
      INSERT INTO persona_browser_runtime (
        persona_uid,
        state,
        pid,
        process_start_ticks,
        executable_path,
        executable_real_path,
        browser_version,
        devtools_port,
        devtools_path,
        started_at,
        updated_at,
        last_error
      ) VALUES (?, 'STARTING', NULL, NULL, ?, NULL, ?, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(persona_uid) DO NOTHING
    `).run(personaUid, executablePath, browserVersion, now, now);

    if (result.changes !== 1) {
      throw new Error(`Persona ${personaUid} already has persisted Chromium runtime evidence`);
    }
    const record = this.get(personaUid);
    if (record === null) {
      throw new Error("Chromium runtime launch intent was not persisted");
    }
    return record;
  }

  public recordProcess(
    personaUid: string,
    fingerprint: ChromiumProcessFingerprint
  ): ChromiumRuntimeRecord {
    const now = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE persona_browser_runtime
      SET
        pid = ?,
        process_start_ticks = ?,
        executable_real_path = ?,
        updated_at = ?
      WHERE persona_uid = ? AND state = 'STARTING'
    `).run(
      fingerprint.pid,
      fingerprint.processStartTicks,
      fingerprint.executableRealPath,
      now,
      personaUid
    );
    const record = this.get(personaUid);
    if (
      record === null ||
      record.pid !== fingerprint.pid ||
      record.processStartTicks !== fingerprint.processStartTicks
    ) {
      throw new Error("Chromium process ownership evidence was not persisted");
    }
    return record;
  }

  public markRunning(
    personaUid: string,
    port: number,
    devToolsPath: string
  ): ChromiumRuntimeRecord {
    const now = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE persona_browser_runtime
      SET
        state = 'RUNNING',
        devtools_port = ?,
        devtools_path = ?,
        updated_at = ?,
        last_error = NULL
      WHERE
        persona_uid = ? AND
        pid IS NOT NULL AND
        process_start_ticks IS NOT NULL AND
        executable_real_path IS NOT NULL
    `).run(port, devToolsPath, now, personaUid);

    const record = this.get(personaUid);
    if (record === null || record.state !== "RUNNING") {
      throw new Error("Chromium runtime did not enter RUNNING state");
    }
    return record;
  }

  public markDegraded(
    personaUid: string,
    message: string
  ): ChromiumRuntimeRecord {
    const now = this.#now().toISOString();
    const bounded = message.slice(0, MAX_RUNTIME_ERROR_LENGTH);
    const existing = this.get(personaUid);
    if (existing === null) {
      this.#database.prepare(`
        INSERT INTO persona_browser_runtime (
          persona_uid,
          state,
          pid,
          process_start_ticks,
          executable_path,
          executable_real_path,
          browser_version,
          devtools_port,
          devtools_path,
          started_at,
          updated_at,
          last_error
        ) VALUES (?, 'DEGRADED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(personaUid, now, now, bounded);
    } else {
      this.#database.prepare(`
        UPDATE persona_browser_runtime
        SET state = 'DEGRADED', updated_at = ?, last_error = ?
        WHERE persona_uid = ?
      `).run(now, bounded, personaUid);
    }

    const record = this.get(personaUid);
    if (record === null || record.state !== "DEGRADED") {
      throw new Error("Chromium runtime did not enter DEGRADED state");
    }
    return record;
  }

  public clear(personaUid: string): void {
    this.#database.prepare(`
      DELETE FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).run(personaUid);
  }
}
