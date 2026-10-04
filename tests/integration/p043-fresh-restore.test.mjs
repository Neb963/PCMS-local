import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  createCoreStateBackup
} from "../../dist/backup/core-backup.js";
import {
  restoreCoreStateBackup
} from "../../dist/backup/core-restore.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { ModuleManager } from "../../dist/modules/manager.js";
import { PersonaRepository } from "../../dist/personas/repository.js";
import { ProjectRepository } from "../../dist/projects/project-repository.js";
import {
  readRecoveryControl
} from "../../dist/recovery/recovery-control.js";
import { openPcmsDatabase } from "../../dist/storage/database.js";
import {
  createReferenceModulePackage,
  REFERENCE_MODULE_ID
} from "../helpers/reference-module-fixture.mjs";

test("P043 fresh-install restore reconstructs Core relationships and active module package/state", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p043-fresh-restore-")
  );
  const sourceRoot = join(outer, "source");
  const backupRoot = join(outer, "backups");
  const freshRoot = join(outer, "fresh-install");
  const source = openPcmsDatabase(
    join(sourceRoot, "pcms.db"),
    {
      now: () => new Date("2026-10-04T02:00:00.000Z")
    }
  );

  try {
    const createdAt = "2026-10-04T02:01:00.000Z";
    source.connection.prepare(`
      INSERT INTO personas (
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        profile_delete_state,
        profile_deleted_at,
        profile_backup_decision,
        created_at,
        updated_at,
        retired_at,
        revision
      ) VALUES (
        'persona_restore',
        'ACTIVE',
        'CLOSED',
        'chromium-v1',
        'personas/persona_restore/chromium',
        'PRESENT',
        NULL,
        NULL,
        ?,
        ?,
        NULL,
        0
      )
    `).run(createdAt, createdAt);

    const accounts = new AccountRepository({
      database: source.connection,
      now: () => new Date("2026-10-04T02:02:00.000Z")
    });
    accounts.create({
      accountId: "account_restore",
      displayName: "Restore Account"
    });
    const bindings = new PersonaBindingService({
      database: source.connection,
      now: () => new Date("2026-10-04T02:03:00.000Z")
    });
    bindings.bind({
      accountId: "account_restore",
      personaUid: "persona_restore",
      expectedRevision: 0,
      reason: "P043 fresh-install restore fixture"
    });

    const generators = new GeneratorRepository({
      database: source.connection,
      now: () => new Date("2026-10-04T02:04:00.000Z")
    });
    generators.create({
      generatorLocalId: "generator_restore",
      accountId: "account_restore",
      providerStableId: "provider-restore-001",
      currentSlug: "restore-generator"
    });
    const projects = new ProjectRepository({
      database: source.connection,
      now: () => new Date("2026-10-04T02:05:00.000Z")
    });
    projects.create({
      projectId: "project_restore",
      generatorLocalId: "generator_restore"
    });

    const sourceModules = new ModuleManager(
      source.connection,
      {
        packageRoot: join(sourceRoot, "modules"),
        now: () => new Date("2026-10-04T02:06:00.000Z")
      }
    );
    const installed = await sourceModules.installPackage(
      createReferenceModulePackage("1.0.0")
    );
    sourceModules.stateStore.setActiveValue(
      REFERENCE_MODULE_ID,
      installed.registration.runtimeGeneration,
      "restore.marker",
      {
        projectId: "project_restore",
        enabled: true
      }
    );

    const backup = await createCoreStateBackup({
      database: source.connection,
      liveDataRoot: sourceRoot,
      modulePackageRoot: join(sourceRoot, "modules"),
      backupRoot,
      now: () => new Date("2026-10-04T02:07:00.000Z")
    });
    source.close();

    const restored = await restoreCoreStateBackup({
      backupDirectory: backup.directory,
      liveDataRoot: freshRoot,
      now: () => new Date("2026-10-04T02:08:00.000Z")
    });
    assert.equal(restored.safetyDirectory, null);
    assert.equal(restored.assessment.mode, "RECOVERY_HOLD");
    assert.deepEqual(restored.assessment.modules, [{
      moduleId: REFERENCE_MODULE_ID,
      version: "1.0.0",
      status: "AVAILABLE"
    }]);

    const database = openPcmsDatabase(
      join(freshRoot, "pcms.db")
    );
    try {
      assert.equal(
        readRecoveryControl(database.connection).mode,
        "RECOVERY_HOLD"
      );

      const restoredAccount = new AccountRepository({
        database: database.connection
      }).require("account_restore");
      assert.equal(
        restoredAccount.personaUid,
        "persona_restore"
      );

      const restoredPersona = new PersonaRepository({
        database: database.connection
      }).get("persona_restore");
      assert.ok(restoredPersona);
      assert.equal(
        restoredPersona.profileRelativePath,
        "personas/persona_restore/chromium"
      );

      const restoredBindings = new PersonaBindingService({
        database: database.connection
      }).listHistory("account_restore");
      assert.equal(restoredBindings.length, 1);
      assert.equal(
        restoredBindings[0].nextPersonaUid,
        "persona_restore"
      );

      const restoredGenerator = new GeneratorRepository({
        database: database.connection
      }).require("generator_restore");
      assert.equal(
        restoredGenerator.accountId,
        "account_restore"
      );
      assert.equal(
        restoredGenerator.providerStableId,
        "provider-restore-001"
      );

      const restoredProject = new ProjectRepository({
        database: database.connection
      }).require("project_restore");
      assert.equal(
        restoredProject.generatorLocalId,
        "generator_restore"
      );

      const restoredModules = new ModuleManager(
        database.connection,
        {
          packageRoot: join(freshRoot, "modules")
        }
      );
      const registration =
        restoredModules.stateStore.getRegistration(
          REFERENCE_MODULE_ID
        );
      assert.equal(registration.activeVersion, "1.0.0");
      assert.equal(registration.stateRevision, 1);
      assert.deepEqual(
        restoredModules.stateStore.readActiveState(
          REFERENCE_MODULE_ID
        ).state,
        {
          "restore.marker": {
            enabled: true,
            projectId: "project_restore"
          }
        }
      );

      const restoredPackage =
        await restoredModules.packageStore.getInstalled(
          REFERENCE_MODULE_ID,
          "1.0.0"
        );
      assert.equal(
        restoredPackage.sha256,
        installed.package.sha256
      );
      assert.equal(
        restoredPackage.manifest.id,
        REFERENCE_MODULE_ID
      );
    } finally {
      database.close();
    }
  } finally {
    if (source.connection.isOpen) {
      source.close();
    }
    await rm(outer, {
      recursive: true,
      force: true
    });
  }
});
