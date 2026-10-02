import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CORE_MIGRATIONS } from "../../dist/storage/core-migrations.js";
import {
  DatabaseOpenError,
  openPcmsDatabase
} from "../../dist/storage/database.js";
import {
  DatabaseMigrationError,
  DatabaseSchemaError,
  PCMS_APPLICATION_ID
} from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function createDatabasePath(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    path: join(root, "pcms.db")
  };
}

test("fresh database initializes PCMS identity, schema version and migration history", async () => {
  const fixture = await createDatabasePath("pcms-db-fresh-");
  try {
    const database = openPcmsDatabase(fixture.path);
    assert.equal(database.applicationId, PCMS_APPLICATION_ID);
    assert.equal(database.schemaVersion, CORE_MIGRATIONS.length);
    database.close();

    const raw = openConfiguredSqliteDatabase(fixture.path);
    try {
      assert.equal(
        raw.prepare("PRAGMA application_id").get().application_id,
        PCMS_APPLICATION_ID
      );
      assert.equal(raw.prepare("PRAGMA user_version").get().user_version, CORE_MIGRATIONS.length);
      assert.equal(
        raw.prepare("SELECT count(*) AS count FROM schema_migrations").get().count,
        CORE_MIGRATIONS.length
      );
    } finally {
      raw.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("existing database upgrades in order when a new immutable migration is appended", async () => {
  const fixture = await createDatabasePath("pcms-db-upgrade-");
  const migrations = [
    ...CORE_MIGRATIONS,
    {
      version: CORE_MIGRATIONS.length + 1,
      id: "0003-upgrade-fixture",
      sql: "CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY) STRICT;"
    }
  ];

  try {
    const first = openPcmsDatabase(fixture.path);
    first.close();

    const upgraded = openPcmsDatabase(fixture.path, {
      migrations,
      now: () => new Date("2026-10-02T01:00:00.000Z")
    });
    assert.equal(upgraded.schemaVersion, CORE_MIGRATIONS.length + 1);
    upgraded.close();

    const raw = openConfiguredSqliteDatabase(fixture.path);
    try {
      assert.equal(raw.prepare("PRAGMA user_version").get().user_version, CORE_MIGRATIONS.length + 1);
      assert.equal(
        raw.prepare(`
          SELECT count(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'upgrade_probe'
        `).get().count,
        1
      );
      assert.equal(
        raw.prepare("SELECT count(*) AS count FROM schema_migrations").get().count,
        CORE_MIGRATIONS.length + 1
      );
    } finally {
      raw.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed migration rolls back schema effects, history and user_version", async () => {
  const fixture = await createDatabasePath("pcms-db-rollback-");
  const migrations = [
    ...CORE_MIGRATIONS,
    {
      version: CORE_MIGRATIONS.length + 1,
      id: "0003-failing-fixture",
      sql: `
        CREATE TABLE should_rollback (id INTEGER PRIMARY KEY) STRICT;
        SELECT no_such_function();
      `
    }
  ];

  try {
    const first = openPcmsDatabase(fixture.path);
    first.close();

    assert.throws(
      () => openPcmsDatabase(fixture.path, { migrations }),
      DatabaseMigrationError
    );

    const raw = openConfiguredSqliteDatabase(fixture.path);
    try {
      assert.equal(raw.prepare("PRAGMA user_version").get().user_version, CORE_MIGRATIONS.length);
      assert.equal(
        raw.prepare(`
          SELECT count(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'should_rollback'
        `).get().count,
        0
      );
      assert.equal(
        raw.prepare("SELECT count(*) AS count FROM schema_migrations").get().count,
        CORE_MIGRATIONS.length
      );
    } finally {
      raw.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects foreign application identity and newer unsupported schema", async () => {
  const foreign = await createDatabasePath("pcms-db-foreign-");
  const newer = await createDatabasePath("pcms-db-newer-");

  try {
    const foreignRaw = openConfiguredSqliteDatabase(foreign.path);
    foreignRaw.exec("PRAGMA application_id = 12345");
    foreignRaw.close();

    assert.throws(
      () => openPcmsDatabase(foreign.path),
      DatabaseSchemaError
    );

    const current = openPcmsDatabase(newer.path);
    current.close();

    const newerRaw = openConfiguredSqliteDatabase(newer.path);
    newerRaw.exec("PRAGMA user_version = 99");
    newerRaw.close();

    assert.throws(
      () => openPcmsDatabase(newer.path),
      DatabaseSchemaError
    );
  } finally {
    await rm(foreign.root, { recursive: true, force: true });
    await rm(newer.root, { recursive: true, force: true });
  }
});

test("rejects an unowned non-empty database and corrupt database bytes", async () => {
  const unowned = await createDatabasePath("pcms-db-unowned-");
  const corrupt = await createDatabasePath("pcms-db-corrupt-");

  try {
    const raw = openConfiguredSqliteDatabase(unowned.path);
    raw.exec("CREATE TABLE foreign_table (id INTEGER PRIMARY KEY) STRICT");
    raw.close();

    assert.throws(
      () => openPcmsDatabase(unowned.path),
      DatabaseSchemaError
    );

    await writeFile(corrupt.path, Buffer.from("not a sqlite database"));
    assert.throws(
      () => openPcmsDatabase(corrupt.path),
      DatabaseOpenError
    );
  } finally {
    await rm(unowned.root, { recursive: true, force: true });
    await rm(corrupt.root, { recursive: true, force: true });
  }
});
