import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoreBackupError,
  createCoreStateBackup,
  validateCoreStateBackup
} from "../../dist/backup/core-backup.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import {
  ModuleRuntimeError,
  startModuleRuntime
} from "../../dist/modules/runner.js";
import {
  BoundedWorkQueue,
  WorkQueueError
} from "../../dist/scheduler/work-queue.js";
import { openPcmsDatabase } from "../../dist/storage/database.js";
import {
  openConfiguredSqliteDatabase
} from "../../dist/storage/sqlite.js";

function sqliteMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

test("P045 SQLite busy is time-bounded and recovers after the writer releases", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-db-busy-")
  );
  const path = join(root, "busy.db");
  const writer = openConfiguredSqliteDatabase(path);
  const contender = openConfiguredSqliteDatabase(path);

  try {
    writer.exec(
      "CREATE TABLE pressure(id INTEGER PRIMARY KEY, value TEXT)"
    );
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare(
      "INSERT INTO pressure(value) VALUES (?)"
    ).run("writer-holds-lock");

    contender.exec("PRAGMA busy_timeout = 75");
    const started = Date.now();
    assert.throws(
      () =>
        contender.prepare(
          "INSERT INTO pressure(value) VALUES (?)"
        ).run("contender"),
      (error) => {
        assert.match(
          sqliteMessage(error),
          /(locked|busy)/iu
        );
        return true;
      }
    );
    assert.ok(
      Date.now() - started < 1_000,
      "busy injection must remain bounded"
    );

    writer.exec("ROLLBACK");
    contender.prepare(
      "INSERT INTO pressure(value) VALUES (?)"
    ).run("after-release");
    assert.equal(
      contender.prepare(
        "SELECT COUNT(*) AS count FROM pressure"
      ).get().count,
      1
    );
  } finally {
    if (writer.isOpen) {
      try {
        writer.exec("ROLLBACK");
      } catch {
        // No transaction may be active.
      }
      writer.close();
    }
    if (contender.isOpen) contender.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});

test("P045 SQLite full failure is bounded and leaves the database structurally readable", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-db-full-")
  );
  const database = openConfiguredSqliteDatabase(
    join(root, "full.db")
  );

  try {
    database.exec(
      "CREATE TABLE pressure(id INTEGER PRIMARY KEY, payload BLOB)"
    );
    const pageCount = database.prepare(
      "PRAGMA page_count"
    ).get().page_count;
    assert.equal(typeof pageCount, "number");
    database.exec(
      "PRAGMA max_page_count = " +
        String(pageCount + 1)
    );

    assert.throws(
      () =>
        database.prepare(
          "INSERT INTO pressure(payload) VALUES (?)"
        ).run(Buffer.alloc(1024 * 1024)),
      (error) => {
        assert.match(
          sqliteMessage(error),
          /(full|disk)/iu
        );
        return true;
      }
    );

    assert.equal(
      database.prepare("PRAGMA quick_check").get()
        .quick_check,
      "ok"
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM pressure"
      ).get().count,
      0
    );
  } finally {
    database.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});

test("P045 corrupt Core backup fails with bounded structured evidence", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-corrupt-backup-")
  );
  const live = join(root, "live");
  const backups = join(root, "backups");
  const modules = join(live, "modules");
  await mkdir(modules, { recursive: true });
  const database = openPcmsDatabase(
    join(live, "pcms.db")
  );

  try {
    const created = await createCoreStateBackup({
      database: database.connection,
      liveDataRoot: live,
      modulePackageRoot: modules,
      backupRoot: backups,
      now: () =>
        new Date("2026-10-04T03:00:00.000Z")
    });
    const databasePath = join(
      created.directory,
      "pcms.db"
    );
    await chmod(databasePath, 0o600);
    await writeFile(
      databasePath,
      Buffer.concat([
        await readFile(databasePath),
        Buffer.from("corrupt")
      ])
    );

    await assert.rejects(
      () => validateCoreStateBackup(created.directory),
      (error) => {
        assert.ok(error instanceof CoreBackupError);
        assert.equal(
          error.code,
          "BACKUP_HASH_MISMATCH"
        );
        assert.ok(error.message.length < 256);
        assert.match(
          error.message,
          /backup file (size|digest) differs/iu
        );
        return true;
      }
    );
  } finally {
    database.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});

test("P045 queue flood and hung module preserve recovery interactive and daemon control lanes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-pressure-")
  );
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const daemon = await startPcmsd({
    paths,
    port: 0
  });
  const packageRoot = join(root, "poison-module");
  const backend = join(packageRoot, "backend");
  await mkdir(backend, { recursive: true });
  await writeFile(
    join(backend, "index.mjs"),
    `
      export function createModule() {
        return {
          async handle(method) {
            if (method === "hang") {
              return new Promise(() => {});
            }
            return "ok";
          }
        };
      }
    `
  );

  const runtime = await startModuleRuntime({
    moduleId: "fixture.p045-poison",
    version: "1.0.0",
    packageRoot,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 1,
    limits: {
      requestTimeoutMs: 100
    }
  });

  try {
    const queue = new BoundedWorkQueue(8);
    const createdAt =
      "2026-10-04T03:10:00.000Z";

    for (let index = 0; index < 6; index += 1) {
      assert.equal(
        queue.enqueue({
          key: "background-" + String(index),
          priority: "BACKGROUND",
          fairnessKey: "poison-module",
          createdAt,
          value: index
        }),
        "ENQUEUED"
      );
    }
    assert.throws(
      () =>
        queue.enqueue({
          key: "background-overflow",
          priority: "BACKGROUND",
          fairnessKey: "poison-module",
          createdAt,
          value: -1
        }),
      (error) => {
        assert.ok(error instanceof WorkQueueError);
        assert.equal(error.code, "WORK_QUEUE_FULL");
        assert.equal(error.retryable, true);
        assert.match(
          error.message,
          /preserving interactive\/recovery capacity/
        );
        return true;
      }
    );

    assert.equal(
      queue.enqueue({
        key: "interactive-control",
        priority: "INTERACTIVE",
        fairnessKey: "operator",
        createdAt,
        value: "interactive"
      }),
      "ENQUEUED"
    );
    assert.throws(
      () =>
        queue.enqueue({
          key: "interactive-overflow",
          priority: "INTERACTIVE",
          fairnessKey: "operator",
          createdAt,
          value: "interactive-overflow"
        }),
      (error) => {
        assert.ok(error instanceof WorkQueueError);
        assert.match(
          error.message,
          /preserving recovery capacity/
        );
        return true;
      }
    );
    assert.equal(
      queue.enqueue({
        key: "recovery-control",
        priority: "RECOVERY",
        fairnessKey: "recovery",
        createdAt,
        value: "recovery"
      }),
      "ENQUEUED"
    );
    assert.equal(queue.size, queue.capacity);

    const poison = runtime.request("hang", {});
    const health = await fetch(
      daemon.origin + "/api/v1/health"
    );
    assert.equal(health.status, 200);

    const first = queue.claimNext(
      new Date(createdAt)
    );
    assert.equal(first?.key, "recovery-control");
    queue.complete(first.key);
    const second = queue.claimNext(
      new Date(createdAt)
    );
    assert.equal(second?.key, "interactive-control");
    queue.complete(second.key);

    await assert.rejects(
      () => poison,
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RPC_TIMEOUT"
    );

    const healthAfter = await fetch(
      daemon.origin + "/api/v1/health"
    );
    assert.equal(healthAfter.status, 200);
  } finally {
    await runtime.stop().catch(() => undefined);
    await daemon.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});
