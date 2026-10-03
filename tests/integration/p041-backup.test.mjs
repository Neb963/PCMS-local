import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoreBackupError,
  createAutomaticCoreStateBackup,
  createCoreStateBackup,
  validateCoreStateBackup
} from "../../dist/backup/core-backup.js";
import { ModuleManager } from "../../dist/modules/manager.js";
import { openPcmsDatabase } from "../../dist/storage/database.js";
import {
  createReferenceModulePackage,
  REFERENCE_MODULE_ID
} from "../helpers/reference-module-fixture.mjs";

test("coherent Core backup validates DB, module package manifests and hashes while excluding profiles", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p041-backup-")
  );
  const liveDataRoot = join(outer, "live");
  const backupRoot = join(outer, "backups");
  const modulePackageRoot = join(liveDataRoot, "modules");
  await mkdir(liveDataRoot, { recursive: true });
  const database = openPcmsDatabase(
    join(liveDataRoot, "pcms.db")
  );
  const manager = new ModuleManager(database.connection, {
    packageRoot: modulePackageRoot,
    now: () => new Date("2026-10-04T01:00:00.000Z")
  });

  try {
    const installed = await manager.installPackage(
      createReferenceModulePackage("1.0.0")
    );
    manager.stateStore.writeActiveState(
      REFERENCE_MODULE_ID,
      installed.registration.runtimeGeneration,
      installed.registration.stateRevision,
      {
        backupMarker: "authoritative-module-state"
      }
    );

    const profileSentinel = join(
      liveDataRoot,
      "personas",
      "persona-p041",
      "Default",
      "Cookies"
    );
    await mkdir(join(profileSentinel, ".."), {
      recursive: true
    });
    await writeFile(
      profileSentinel,
      "browser-state-must-not-be-backed-up"
    );

    const created = await createCoreStateBackup({
      database: database.connection,
      liveDataRoot,
      modulePackageRoot,
      backupRoot,
      now: () => new Date("2026-10-04T02:00:00.000Z")
    });
    const manifest = await validateCoreStateBackup(
      created.directory
    );

    assert.equal(
      manifest.format,
      "pcms-core-backup-v1"
    );
    assert.deepEqual(manifest.profiles, {
      included: false,
      reason: "core-backup-excludes-browser-profiles"
    });
    assert.equal(manifest.modules.length, 1);
    assert.equal(
      manifest.modules[0].moduleId,
      REFERENCE_MODULE_ID
    );
    assert.equal(manifest.modules[0].version, "1.0.0");
    assert.equal(
      manifest.modules[0].sha256,
      installed.package.sha256
    );
    assert.equal(
      manifest.modules[0].manifest.id,
      REFERENCE_MODULE_ID
    );
    assert.equal(
      manifest.files.filter(
        (entry) => entry.kind === "database"
      ).length,
      1
    );
    assert.equal(
      manifest.files.filter(
        (entry) => entry.kind === "module-package"
      ).length,
      1
    );
    assert.ok(
      manifest.files.every(
        (entry) =>
          !entry.path.includes("personas") &&
          !entry.path.includes("Cookies")
      )
    );
    assert.equal(
      (await readFile(profileSentinel, "utf8")),
      "browser-state-must-not-be-backed-up"
    );

    const modulePath = join(
      created.directory,
      ...manifest.modules[0].path.split("/")
    );
    await chmod(modulePath, 0o600);
    await writeFile(
      modulePath,
      Buffer.concat([
        await readFile(modulePath),
        Buffer.from("tampered")
      ])
    );

    await assert.rejects(
      () => validateCoreStateBackup(created.directory),
      (error) =>
        error instanceof CoreBackupError &&
        error.code === "BACKUP_HASH_MISMATCH"
    );
  } finally {
    database.close();
    await rm(outer, { recursive: true, force: true });
  }
});

test("automatic retention prunes only managed Core backups and never copies or deletes browser profiles", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p041-retention-")
  );
  const liveDataRoot = join(outer, "live");
  const backupRoot = join(outer, "backups");
  const modulePackageRoot = join(liveDataRoot, "modules");
  await mkdir(modulePackageRoot, { recursive: true });
  const database = openPcmsDatabase(
    join(liveDataRoot, "pcms.db")
  );

  try {
    const profileSentinel = join(
      liveDataRoot,
      "personas",
      "persona-retention",
      "Default",
      "Cookies"
    );
    await mkdir(join(profileSentinel, ".."), {
      recursive: true
    });
    await writeFile(profileSentinel, "persistent-browser-state");

    const unrelated = join(
      backupRoot,
      "operator-notes",
      "keep.txt"
    );
    await mkdir(join(unrelated, ".."), {
      recursive: true
    });
    await writeFile(unrelated, "do-not-delete");

    const first = await createAutomaticCoreStateBackup({
      database: database.connection,
      liveDataRoot,
      modulePackageRoot,
      backupRoot,
      retentionCount: 2,
      now: () => new Date("2026-10-04T03:00:00.000Z")
    });
    const second = await createAutomaticCoreStateBackup({
      database: database.connection,
      liveDataRoot,
      modulePackageRoot,
      backupRoot,
      retentionCount: 2,
      now: () => new Date("2026-10-04T04:00:00.000Z")
    });
    const third = await createAutomaticCoreStateBackup({
      database: database.connection,
      liveDataRoot,
      modulePackageRoot,
      backupRoot,
      retentionCount: 2,
      now: () => new Date("2026-10-04T05:00:00.000Z")
    });

    assert.equal(first.prunedBackupIds.length, 0);
    assert.equal(second.prunedBackupIds.length, 0);
    assert.deepEqual(third.prunedBackupIds, [
      first.manifest.backupId
    ]);

    const managed = (
      await readdir(backupRoot, { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("core-")
      )
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(
      managed,
      [
        second.manifest.backupId,
        third.manifest.backupId
      ].sort()
    );

    for (const backupId of managed) {
      const manifest = await validateCoreStateBackup(
        join(backupRoot, backupId)
      );
      assert.equal(manifest.profiles.included, false);
      assert.ok(
        manifest.files.every(
          (entry) => !entry.path.includes("personas")
        )
      );
    }

    assert.equal(
      await readFile(profileSentinel, "utf8"),
      "persistent-browser-state"
    );
    assert.equal(
      await readFile(unrelated, "utf8"),
      "do-not-delete"
    );
  } finally {
    database.close();
    await rm(outer, { recursive: true, force: true });
  }
});
