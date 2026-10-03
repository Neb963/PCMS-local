import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import { BrowserDriver } from "../../dist/browser/browser-driver.js";
import { DeploymentArtifactResolver } from "../../dist/deployer/artifact-selection.js";
import { ExactCommitRepositoryScanner } from "../../dist/deployer/github-repository.js";
import { InitialDeploymentService } from "../../dist/deployer/initial-deployment.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { ModuleStateStore } from "../../dist/modules/state-store.js";
import { OperationCoordinator } from "../../dist/operations/operation-coordinator.js";
import { ChromiumBrowserManager } from "../../dist/personas/chromium-browser.js";
import { PersonaProfileLifecycle } from "../../dist/personas/profile-lifecycle.js";
import { PerchanceProvider } from "../../dist/providers/perchance-provider.js";
import { ensurePcmsDirectories, resolvePcmsPaths } from "../../dist/config/paths.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import { startPerchanceEmulator } from "../helpers/perchance-emulator.mjs";
import { createZip } from "../helpers/zip-fixture.mjs";

const SESSION_STORAGE_KEY = "pcms.perchance.emulator.session";
const SESSION_STATE_EXPRESSION = `(() => {
  const raw = sessionStorage.getItem("${SESSION_STORAGE_KEY}");
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return {
      identity: typeof value.identity === "string" ? value.identity : null,
      sessionToken:
        typeof value.sessionToken === "string" ? value.sessionToken : null
    };
  } catch {
    return null;
  }
})()`;

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required for real-browser acceptance");
  return value;
}

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
  applyPcmsMigrations(database);
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot
  });
  const manager = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  const driver = new BrowserDriver({
    browserManager: manager,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000
  });
  return { root, database, lifecycle, manager, driver };
}

async function selectLoadedPage(connection, url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const target = (await connection.listPages()).find(
      (candidate) => candidate.url === url
    );
    if (target !== undefined) {
      const page = await connection.selectPage({
        targetId: target.targetId
      });
      while (Date.now() < deadline) {
        const readyState = await page.evaluate("document.readyState");
        if (readyState === "complete" || readyState === "interactive") {
          return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("emulator page did not become ready");
}

async function resolvedArtifact() {
  const archive = createZip([
    {
      name: "release/index.html",
      data: "<main>P031 deployed</main>"
    },
    {
      name: "release/src/app.js",
      data: "export const phase = 'P031';"
    }
  ]);
  const commitSha = "c".repeat(40);
  const treeSha = "d".repeat(40);
  const blobSha = "e".repeat(40);
  const adapter = {
    async readCommitTree(input) {
      assert.equal(input.commitSha, commitSha);
      return {
        commitSha,
        treeSha,
        truncated: false,
        entries: [{
          path: "release/generator-1.0.0.zip",
          type: "blob",
          sha: blobSha,
          size: archive.length
        }]
      };
    },
    async readBlob(input) {
      assert.equal(input.commitSha, commitSha);
      assert.equal(input.blobSha, blobSha);
      return archive;
    }
  };
  return new DeploymentArtifactResolver(
    new ExactCommitRepositoryScanner(adapter)
  ).resolve({
    repository: {
      owner: "Neb963",
      repository: "repository-generator",
      commitSha
    },
    discovery: {
      directory: "release",
      artifactName: "generator",
      layout: "SINGLE_DIRECTORY",
      requiredFiles: ["index.html", "src/app.js"]
    },
    selection: { kind: "ONLY" }
  });
}

test("P031 initial emulator deployment uses stable target, OperationCoordinator and independent read-back", async () => {
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "Owner@Example.test",
      sessionToken: "fixture-session-p031",
      generators: [{
        publicId: "public-p031-stable",
        slug: "repository-generator"
      }]
    }]
  });
  const f = await fixture("pcms-deployer-initial-");
  const personaUid = "persona_deployer_initial";
  let session;
  let connection;

  try {
    session = await f.manager.launch(personaUid, {
      initialUrl: emulator.origin,
      headless: true,
      disableSandboxForTesting: true
    });
    connection = await f.driver.connect(personaUid);
    const page = await selectLoadedPage(connection, emulator.origin);
    const browserSession = emulator.sessionFor("owner@example.test");
    await page.evaluate(
      `sessionStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(browserSession))})`
    );

    const accounts = new AccountRepository({ database: f.database });
    const bindings = new PersonaBindingService({ database: f.database });
    const generators = new GeneratorRepository({ database: f.database });
    accounts.create({
      accountId: "account_p031",
      displayName: "P031 Account"
    });
    bindings.bind({
      accountId: "account_p031",
      personaUid,
      expectedRevision: 0,
      reason: "P031 deployment Persona"
    });
    generators.create({
      generatorLocalId: "generator_p031",
      accountId: "account_p031",
      providerStableId: "public-p031-stable",
      currentSlug: "repository-generator"
    });

    const state = new ModuleStateStore(f.database, {
      now: () => new Date("2026-10-03T16:40:00.000Z")
    });
    const registration = state.registerModule(
      "deployer",
      "1.0.0",
      1,
      {}
    );
    const now = () => new Date("2026-10-03T16:40:00.000Z");
    const provider = new PerchanceProvider({
      browserProfile: {
        sessionStateExpression: SESSION_STATE_EXPRESSION
      },
      now
    });
    const coordinator = new OperationCoordinator({
      database: f.database,
      now
    });
    const service = new InitialDeploymentService({
      database: f.database,
      provider,
      coordinator
    });
    const artifact = await resolvedArtifact();

    const result = await service.deploy({
      page,
      artifact,
      accountId: "account_p031",
      expectedProviderIdentity: "owner@example.test",
      requiredPublic: true,
      operationId: "operation-p031-initial",
      idempotencyKey: "request-p031-initial",
      owner: {
        kind: "MODULE",
        moduleId: "deployer",
        moduleVersion: registration.activeVersion,
        runtimeGeneration: registration.runtimeGeneration
      },
      actorSource: "p031-browser-test"
    });

    assert.equal(result.operation.state, "SUCCEEDED");
    assert.equal(
      result.operation.targetKey,
      "perchance:generator:generator_p031"
    );
    assert.equal(result.target.generator.providerStableId, "public-p031-stable");
    assert.equal(result.observation.artifactSha256, artifact.sha256);
    assert.equal(result.observation.isPublic, true);
    assert.equal(result.operation.provenance.commitSha, "c".repeat(40));
    assert.equal(result.operation.provenance.artifactSha256, artifact.sha256);

    const independentlyObserved = emulator.readGenerator(
      "public-p031-stable"
    );
    assert.equal(independentlyObserved.slug, "repository-generator");
    assert.equal(independentlyObserved.artifactSha256, artifact.sha256);
    assert.equal(independentlyObserved.isPublic, true);
    assert.deepEqual(
      independentlyObserved.files,
      [
        {
          path: "index.html",
          contentBase64: Buffer.from("<main>P031 deployed</main>").toString("base64")
        },
        {
          path: "src/app.js",
          contentBase64: Buffer.from("export const phase = 'P031';").toString("base64")
        }
      ]
    );

    const requests = emulator.requests();
    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/api/getGeneratorsByUser",
        "/api/save",
        "/api/getGeneratorPageData"
      ]
    );
    assert.equal(
      requests.filter((request) => request.path === "/api/save").length,
      1
    );
    assert.equal(JSON.stringify(requests).includes("fixture-session-p031"), false);
    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
  } finally {
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
    await emulator.close();
  }
});
