import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CORE_MIGRATIONS } from "../../dist/storage/core-migrations.js";
import {
  DatabaseSchemaError,
  PCMS_APPLICATION_ID,
  applyPcmsMigrations,
  checksumMigration
} from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function withDatabase(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  try {
    await run(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("applies the ordered bootstrap migration and records its immutable checksum", async () => {
  await withDatabase("pcms-migrate-fresh-", (database) => {
    const result = applyPcmsMigrations(database, {
      now: () => new Date("2026-10-02T00:00:00.000Z")
    });

    assert.equal(result.applicationId, PCMS_APPLICATION_ID);
    assert.equal(result.schemaVersion, CORE_MIGRATIONS.length);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].id, "0001-schema-migrations");

    const row = database.prepare(`
      SELECT version, migration_id, checksum, applied_at
      FROM schema_migrations
    `).get();

    assert.deepEqual(row, {
      version: 1,
      migration_id: "0001-schema-migrations",
      checksum: checksumMigration(CORE_MIGRATIONS[0]),
      applied_at: "2026-10-02T00:00:00.000Z"
    });

    const second = applyPcmsMigrations(database);
    assert.equal(second.applied.length, 0);
    assert.equal(second.schemaVersion, 1);
  });
});

test("rejects changed migration content after its checksum has been recorded", async () => {
  await withDatabase("pcms-migrate-checksum-", (database) => {
    applyPcmsMigrations(database);

    const changed = [{
      ...CORE_MIGRATIONS[0],
      sql: `${CORE_MIGRATIONS[0].sql}\n-- changed after release`
    }];

    assert.throws(
      () => applyPcmsMigrations(database, { migrations: changed }),
      DatabaseSchemaError
    );
  });
});

test("rejects gaps and duplicate migration ordering before touching the database", async () => {
  await withDatabase("pcms-migrate-order-", (database) => {
    assert.throws(
      () => applyPcmsMigrations(database, {
        migrations: [{
          version: 2,
          id: "0002-gap",
          sql: "CREATE TABLE test_gap (id INTEGER PRIMARY KEY) STRICT;"
        }]
      }),
      DatabaseSchemaError
    );
  });
});
