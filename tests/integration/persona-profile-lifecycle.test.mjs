import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  PersonaProfileError,
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const database = openConfiguredSqliteDatabase(paths.databasePath);
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T00:00:00.000Z")
  });
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot,
    now: () => new Date("2026-10-03T00:01:00.000Z")
  });
  return { root, paths, database, lifecycle };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("allocates stable owned Chromium roots keyed only by safe Persona UID", async () => {
  const f = await fixture("pcms-persona-profile-");
  try {
    const first = await f.lifecycle.allocate("persona_001");
    const second = await f.lifecycle.allocate("persona_001");
    const other = await f.lifecycle.allocate("persona_002");

    assert.equal(first.profilePath, second.profilePath);
    assert.notEqual(first.profilePath, other.profilePath);
    assert.equal(first.record.profileRelativePath, "personas/persona_001/chromium");
    assert.equal(first.record.profileState, "CLOSED");

    const marker = JSON.parse(
      await readFile(join(first.profilePath, ".pcms-persona-profile.json"), "utf8")
    );
    assert.deepEqual(marker, {
      format: 1,
      personaUid: "persona_001",
      backend: "chromium-v1"
    });
  } finally {
    await cleanup(f);
  }
});

test("refuses traversal identifiers, symlink escapes and incompatible nonempty Persona directories", async () => {
  const f = await fixture("pcms-persona-profile-safety-");
  const outside = join(f.root, "outside");
  try {
    await mkdir(outside);
    await assert.rejects(
      () => f.lifecycle.allocate("../escape"),
      (error) => error instanceof PersonaProfileError && error.code === "PERSONA_UID_INVALID"
    );

    await symlink(outside, join(f.paths.personasRoot, "persona_link"));
    await assert.rejects(
      () => f.lifecycle.allocate("persona_link"),
      (error) => error instanceof PersonaProfileError && error.code === "PERSONA_PROFILE_UNSAFE"
    );

    const incompatible = join(f.paths.personasRoot, "persona_existing");
    await mkdir(incompatible);
    await writeFile(join(incompatible, "unexpected.txt"), "operator data");
    await assert.rejects(
      () => f.lifecycle.allocate("persona_existing"),
      (error) => error instanceof PersonaProfileError && error.code === "PERSONA_PROFILE_INCOMPATIBLE"
    );
    assert.equal(
      await readFile(join(incompatible, "unexpected.txt"), "utf8"),
      "operator data"
    );
  } finally {
    await cleanup(f);
  }
});

test("close preserves profile bytes and reopen returns the same persistent root", async () => {
  const f = await fixture("pcms-persona-persistence-");
  try {
    const opened = await f.lifecycle.open("persona_persistent");
    const sentinel = join(opened.profilePath, "pcms-persistence-probe.txt");
    await writeFile(sentinel, "persistent-state", "utf8");
    assert.equal(opened.record.profileState, "OPEN");

    const closed = f.lifecycle.close("persona_persistent");
    assert.equal(closed.profileState, "CLOSED");
    assert.equal(await readFile(sentinel, "utf8"), "persistent-state");

    const reopened = await f.lifecycle.open("persona_persistent");
    assert.equal(reopened.profilePath, opened.profilePath);
    assert.equal(reopened.record.profileState, "OPEN");
    assert.equal(await readFile(sentinel, "utf8"), "persistent-state");

    const closedAgain = f.lifecycle.close("persona_persistent");
    assert.equal(closedAgain.profileState, "CLOSED");
  } finally {
    await cleanup(f);
  }
});

test("missing owned profile is never silently replaced with a fresh identity", async () => {
  const f = await fixture("pcms-persona-missing-profile-");
  try {
    const allocated = await f.lifecycle.allocate("persona_missing");
    await rm(allocated.profilePath, { recursive: true, force: false });

    await assert.rejects(
      () => f.lifecycle.allocate("persona_missing"),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_PROFILE_INCOMPATIBLE"
    );
    await assert.rejects(() => stat(allocated.profilePath), { code: "ENOENT" });
  } finally {
    await cleanup(f);
  }
});

test("retirement is non-destructive and deletion enforces all guards before removing an owned profile", async () => {
  const f = await fixture("pcms-persona-delete-guards-");
  try {
    const opened = await f.lifecycle.open("persona_retire");
    await writeFile(join(opened.profilePath, "session-state.txt"), "keep-me");

    assert.throws(
      () => f.lifecycle.retire("persona_retire"),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_PROFILE_OPEN"
    );

    f.lifecycle.close("persona_retire");
    const retired = f.lifecycle.retire("persona_retire");
    assert.equal(retired.lifecycleStatus, "RETIRED");
    assert.equal(await readFile(join(opened.profilePath, "session-state.txt"), "utf8"), "keep-me");

    await assert.rejects(
      () => f.lifecycle.open("persona_retire"),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_RETIRED"
    );

    const baseDelete = {
      confirmed: true,
      browserClosed: true,
      unresolvedOperations: 0,
      unresolvedHumanTasks: 0,
      backupDecision: "SKIPPED"
    };

    await assert.rejects(
      () => f.lifecycle.deleteProfile("persona_retire", { ...baseDelete, confirmed: false }),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_DELETE_CONFIRMATION_REQUIRED"
    );
    await assert.rejects(
      () => f.lifecycle.deleteProfile("persona_retire", { ...baseDelete, browserClosed: false }),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_DELETE_BROWSER_NOT_CLOSED"
    );
    await assert.rejects(
      () => f.lifecycle.deleteProfile("persona_retire", { ...baseDelete, unresolvedOperations: 1 }),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_DELETE_UNRESOLVED_EVIDENCE"
    );
    await assert.rejects(
      () => f.lifecycle.deleteProfile("persona_retire", { ...baseDelete, unresolvedHumanTasks: 1 }),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_DELETE_UNRESOLVED_EVIDENCE"
    );
    const { backupDecision: _omit, ...withoutBackup } = baseDelete;
    await assert.rejects(
      () => f.lifecycle.deleteProfile("persona_retire", withoutBackup),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_DELETE_BACKUP_DECISION_REQUIRED"
    );

    const deleted = await f.lifecycle.deleteProfile("persona_retire", baseDelete);
    assert.equal(deleted.profileBackupDecision, "SKIPPED");
    assert.notEqual(deleted.profileDeletedAt, null);
    await assert.rejects(() => stat(opened.profilePath), { code: "ENOENT" });

    await assert.rejects(
      () => f.lifecycle.allocate("persona_retire"),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_PROFILE_DELETED"
    );
  } finally {
    await cleanup(f);
  }
});

test("tampered stored relative path cannot redirect destructive deletion", async () => {
  const f = await fixture("pcms-persona-delete-path-");
  const outside = join(f.root, "outside-delete-target");
  try {
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside");

    const allocated = await f.lifecycle.allocate("persona_tampered");
    f.lifecycle.retire("persona_tampered");
    f.database.prepare(
      "UPDATE personas SET profile_relative_path = ? WHERE persona_uid = ?"
    ).run("../../outside-delete-target", "persona_tampered");

    await assert.rejects(
      () =>
        f.lifecycle.deleteProfile("persona_tampered", {
          confirmed: true,
          browserClosed: true,
          unresolvedOperations: 0,
          unresolvedHumanTasks: 0,
          backupDecision: "BACKED_UP"
        }),
      (error) =>
        error instanceof PersonaProfileError &&
        error.code === "PERSONA_PROFILE_PATH_MISMATCH"
    );

    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside");
    assert.equal((await stat(allocated.profilePath)).isDirectory(), true);
  } finally {
    await cleanup(f);
  }
});
