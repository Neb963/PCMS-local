import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import { readLocalApiToken } from "../../dist/auth/local-api.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

const DORMANT_COUNT = 64;

async function createScaleFixture(prefix) {
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
    now: () => new Date("2026-10-03T12:10:00.000Z")
  });

  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot,
    now: () => new Date("2026-10-03T12:11:00.000Z")
  });
  const accounts = new AccountRepository({
    database,
    now: () => new Date("2026-10-03T12:12:00.000Z")
  });
  const bindings = new PersonaBindingService({
    database,
    now: () => new Date("2026-10-03T12:13:00.000Z")
  });

  for (let index = 0; index < DORMANT_COUNT; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const personaUid = `persona_${suffix}`;
    const accountId = `account_${suffix}`;

    const allocated = await lifecycle.allocate(personaUid);
    assert.equal(allocated.record.profileState, "CLOSED");

    accounts.create({
      accountId,
      displayName: `Dormant Account ${suffix}`
    });
    bindings.bind({
      accountId,
      personaUid,
      expectedRevision: 0,
      reason: "P024 scale fixture"
    });
  }

  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM persona_browser_runtime"
    ).get().count,
    0
  );
  database.close();
  return { root, paths };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test("64 dormant Account/Persona pairs stay queryable without starting browser runtimes", async () => {
  const fixture = await createScaleFixture("pcms-inventory-scale-");
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });

  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);

    const accountsResponse = await fetch(
      `${daemon.origin}/api/v1/accounts`,
      { headers: auth(token) }
    );
    assert.equal(accountsResponse.status, 200);
    const accountsPayload = await accountsResponse.json();
    assert.equal(accountsPayload.accounts.length, DORMANT_COUNT);
    assert.deepEqual(accountsPayload.accounts[63], {
      accountId: "account_063",
      displayName: "Dormant Account 063",
      lifecycleStatus: "ACTIVE",
      personaUid: "persona_063",
      revision: 1
    });

    const exactResponse = await fetch(
      `${daemon.origin}/api/v1/search?q=account_063`,
      { headers: auth(token) }
    );
    assert.equal(exactResponse.status, 200);
    const exactPayload = await exactResponse.json();
    assert.equal(exactPayload.results[0].entityType, "ACCOUNT");
    assert.equal(exactPayload.results[0].entityId, "account_063");

    const boundedResponse = await fetch(
      `${daemon.origin}/api/v1/search?q=account`,
      { headers: auth(token) }
    );
    assert.equal(boundedResponse.status, 200);
    const boundedPayload = await boundedResponse.json();
    assert.equal(boundedPayload.results.length, 50);

    const observation = openConfiguredSqliteDatabase(
      fixture.paths.databasePath
    );
    try {
      const runtimeCount = observation.prepare(
        "SELECT count(*) AS count FROM persona_browser_runtime"
      ).get();
      const openCount = observation.prepare(
        "SELECT count(*) AS count FROM personas WHERE profile_state = 'OPEN'"
      ).get();
      assert.equal(runtimeCount.count, 0);
      assert.equal(openCount.count, 0);
    } finally {
      observation.close();
    }
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});


async function createCorruptionFixture(prefix) {
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
    now: () => new Date("2026-10-03T12:20:00.000Z")
  });
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot,
    now: () => new Date("2026-10-03T12:21:00.000Z")
  });
  const accounts = new AccountRepository({ database });
  const bindings = new PersonaBindingService({ database });

  const profiles = {};
  for (const name of ["good", "missing", "corrupt"]) {
    const personaUid = `persona_${name}`;
    const accountId = `account_${name}`;
    profiles[name] = (await lifecycle.allocate(personaUid)).profilePath;
    accounts.create({
      accountId,
      displayName: `Isolation ${name}`
    });
    bindings.bind({
      accountId,
      personaUid,
      expectedRevision: 0,
      reason: "P024 corruption isolation fixture"
    });
  }

  await rm(profiles.missing, { recursive: true, force: false });
  await writeFile(
    join(profiles.corrupt, ".pcms-persona-profile.json"),
    JSON.stringify({
      format: 1,
      personaUid: "persona_wrong_owner",
      backend: "chromium-v1"
    }) + "\n",
    "utf8"
  );

  database.close();
  return { root, paths };
}

test("missing or corrupt dormant Persona profiles do not poison unrelated inventory", async () => {
  const fixture = await createCorruptionFixture(
    "pcms-inventory-corruption-isolation-"
  );
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });

  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);

    const accountsResponse = await fetch(
      `${daemon.origin}/api/v1/accounts`,
      { headers: auth(token) }
    );
    assert.equal(accountsResponse.status, 200);
    const accountsPayload = await accountsResponse.json();
    assert.deepEqual(
      accountsPayload.accounts.map((account) => account.accountId),
      ["account_corrupt", "account_good", "account_missing"]
    );

    const goodNavigation = await fetch(
      `${daemon.origin}/api/v1/accounts/account_good/persona`,
      { headers: auth(token) }
    );
    assert.equal(goodNavigation.status, 200);
    assert.equal(
      (await goodNavigation.json()).persona.personaUid,
      "persona_good"
    );

    const goodSearch = await fetch(
      `${daemon.origin}/api/v1/search?q=account_good`,
      { headers: auth(token) }
    );
    assert.equal(goodSearch.status, 200);
    assert.equal(
      (await goodSearch.json()).results[0].entityId,
      "account_good"
    );

    const observation = openConfiguredSqliteDatabase(
      fixture.paths.databasePath
    );
    try {
      const lifecycle = new PersonaProfileLifecycle({
        database: observation,
        personasRoot: fixture.paths.personasRoot
      });

      await assert.rejects(
        () => lifecycle.allocate("persona_missing"),
        (error) =>
          error?.code === "PERSONA_PROFILE_INCOMPATIBLE"
      );
      await assert.rejects(
        () => lifecycle.allocate("persona_corrupt"),
        (error) =>
          error?.code === "PERSONA_PROFILE_INCOMPATIBLE"
      );

      const good = await lifecycle.allocate("persona_good");
      assert.equal(good.record.personaUid, "persona_good");
      assert.equal(good.record.profileState, "CLOSED");
    } finally {
      observation.close();
    }
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
