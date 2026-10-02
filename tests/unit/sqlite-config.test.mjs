import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DatabaseConfigurationError,
  SQLITE_BUSY_TIMEOUT_MS,
  openConfiguredSqliteDatabase,
  readSqlitePragmaState
} from "../../dist/storage/sqlite.js";

test("opens file-backed SQLite with required durability and safety pragmas", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-sqlite-config-"));
  const path = join(root, "pcms.db");
  const database = openConfiguredSqliteDatabase(path);

  try {
    const state = readSqlitePragmaState(database);
    assert.deepEqual(state, {
      foreignKeys: true,
      journalMode: "wal",
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      defensiveModeEnabled: true
    });

    assert.throws(() => database.enableLoadExtension(true));
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects relative database paths rather than resolving against cwd", () => {
  assert.throws(
    () => openConfiguredSqliteDatabase("relative/pcms.db"),
    DatabaseConfigurationError
  );
});
