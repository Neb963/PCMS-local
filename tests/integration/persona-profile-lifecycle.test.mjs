import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
