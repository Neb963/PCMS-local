import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import { readLocalApiToken } from "../../dist/auth/local-api.js";
import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

const execFileAsync = promisify(execFile);

async function createFixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await mkdir(dirname(paths.databasePath), { recursive: true });

  const database = openConfiguredSqliteDatabase(paths.databasePath);
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T11:30:00.000Z")
  });

  const now = "2026-10-03T11:31:00.000Z";
  database.prepare(`
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
      'persona_nav',
      'ACTIVE',
      'CLOSED',
      'chromium-v1',
      'personas/persona_nav/chromium',
      'PRESENT',
      NULL,
      NULL,
      ?,
      ?,
      NULL,
      0
    )
  `).run(now, now);

  const accounts = new AccountRepository({
    database,
    now: () => new Date("2026-10-03T11:32:00.000Z")
  });
  accounts.create({
    accountId: "account_nav",
    displayName: "Navigation Account"
  });
  new PersonaBindingService({
    database,
    now: () => new Date("2026-10-03T11:33:00.000Z")
  }).bind({
    accountId: "account_nav",
    personaUid: "persona_nav",
    expectedRevision: 0,
    reason: "control surface fixture"
  });
  new GeneratorRepository({
    database,
    now: () => new Date("2026-10-03T11:34:00.000Z")
  }).create({
    generatorLocalId: "generator_nav",
    accountId: "account_nav",
    providerStableId: "provider-nav-123",
    currentSlug: "mutable-navigation-slug"
  });
  database.close();

  return { root, paths };
}

function auth(token) {
  return {
    authorization: `Bearer ${token}`
  };
}

test("authenticated inventory API and Web UI navigate Account to stored bound Persona", async () => {
  const fixture = await createFixture("pcms-inventory-control-ui-");
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });
  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);

    const unauthorized = await fetch(`${daemon.origin}/api/v1/accounts`);
    assert.equal(unauthorized.status, 401);

    const accountsResponse = await fetch(
      `${daemon.origin}/api/v1/accounts`,
      { headers: auth(token) }
    );
    assert.equal(accountsResponse.status, 200);
    assert.deepEqual(await accountsResponse.json(), {
      accounts: [
        {
          accountId: "account_nav",
          displayName: "Navigation Account",
          lifecycleStatus: "ACTIVE",
          personaUid: "persona_nav",
          revision: 1
        }
      ]
    });

    const personaResponse = await fetch(
      `${daemon.origin}/api/v1/accounts/account_nav/persona`,
      { headers: auth(token) }
    );
    assert.equal(personaResponse.status, 200);
    assert.deepEqual(await personaResponse.json(), {
      accountId: "account_nav",
      persona: {
        personaUid: "persona_nav",
        lifecycleStatus: "ACTIVE",
        profileState: "CLOSED",
        browserBackend: "chromium-v1",
        revision: 0
      }
    });

    const searchResponse = await fetch(
      `${daemon.origin}/api/v1/search?q=provider-nav-123`,
      { headers: auth(token) }
    );
    assert.equal(searchResponse.status, 200);
    assert.deepEqual(await searchResponse.json(), {
      results: [
        {
          entityType: "GENERATOR",
          entityId: "generator_nav",
          label: "mutable-navigation-slug",
          matchedField: "providerStableId",
          accountId: "account_nav",
          personaUid: "persona_nav"
        }
      ]
    });

    const shell = await fetch(daemon.origin);
    const html = await shell.text();
    assert.match(html, /id="accounts"/);
    assert.match(html, /id="search-form"/);
    assert.match(html, /id="persona-panel"/);

    const appJs = await fetch(`${daemon.origin}/app.js`);
    const source = await appJs.text();
    assert.match(source, /\/api\/v1\/accounts/);
    assert.match(source, /Open bound Persona/);
    assert.match(source, /encodeURIComponent\(accountId\)/);
    assert.equal(source.includes(token), false);
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI Account navigation and search resolve stable Core identities", async () => {
  const fixture = await createFixture("pcms-inventory-control-cli-");
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });
  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);
    const env = {
      ...process.env,
      PCMS_CONFIG_ROOT: fixture.paths.configRoot,
      PCMS_DATA_ROOT: fixture.paths.dataRoot,
      PCMS_CACHE_ROOT: fixture.paths.cacheRoot,
      PCMS_PORT: String(daemon.port)
    };

    const accountsResult = await execFileAsync(
      process.execPath,
      ["dist/cli/main.js", "accounts", "list", "--json"],
      { cwd: process.cwd(), env }
    );
    assert.equal(accountsResult.stderr, "");
    assert.equal(accountsResult.stdout.includes(token), false);
    assert.deepEqual(JSON.parse(accountsResult.stdout), {
      ok: true,
      accounts: [
        {
          accountId: "account_nav",
          displayName: "Navigation Account",
          lifecycleStatus: "ACTIVE",
          personaUid: "persona_nav",
          revision: 1
        }
      ]
    });

    const personaResult = await execFileAsync(
      process.execPath,
      [
        "dist/cli/main.js",
        "accounts",
        "persona",
        "account_nav",
        "--json"
      ],
      { cwd: process.cwd(), env }
    );
    assert.equal(personaResult.stderr, "");
    assert.deepEqual(JSON.parse(personaResult.stdout), {
      ok: true,
      navigation: {
        accountId: "account_nav",
        persona: {
          personaUid: "persona_nav",
          lifecycleStatus: "ACTIVE",
          profileState: "CLOSED",
          browserBackend: "chromium-v1",
          revision: 0
        }
      }
    });

    const humanPersona = await execFileAsync(
      process.execPath,
      ["dist/cli/main.js", "accounts", "persona", "account_nav"],
      { cwd: process.cwd(), env }
    );
    assert.equal(humanPersona.stderr, "");
    assert.match(humanPersona.stdout, /^Account: account_nav$/m);
    assert.match(humanPersona.stdout, /^Persona: persona_nav$/m);

    const searchResult = await execFileAsync(
      process.execPath,
      ["dist/cli/main.js", "search", "provider-nav-123", "--json"],
      { cwd: process.cwd(), env }
    );
    assert.equal(searchResult.stderr, "");
    const searchPayload = JSON.parse(searchResult.stdout);
    assert.equal(searchPayload.ok, true);
    assert.equal(searchPayload.results[0].entityId, "generator_nav");
    assert.equal(searchPayload.results[0].matchedField, "providerStableId");
    assert.equal(searchResult.stdout.includes(token), false);
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
