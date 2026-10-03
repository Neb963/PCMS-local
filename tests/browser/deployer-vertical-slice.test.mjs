import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import { BrowserDriver } from "../../dist/browser/browser-driver.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import { DeploymentArtifactResolver } from "../../dist/deployer/artifact-selection.js";
import { ExactCommitRepositoryScanner } from "../../dist/deployer/github-repository.js";
import { InitialDeploymentService } from "../../dist/deployer/initial-deployment.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { ModuleManager } from "../../dist/modules/manager.js";
import { OperationCoordinator } from "../../dist/operations/operation-coordinator.js";
import { ChromiumBrowserManager } from "../../dist/personas/chromium-browser.js";
import { PersonaProfileLifecycle } from "../../dist/personas/profile-lifecycle.js";
import { PerchanceProvider } from "../../dist/providers/perchance-provider.js";
import { ChromiumRoutingManager } from "../../dist/routing/chromium-routing.js";
import { createNativeRouterClient } from "../../dist/routing/native-router-client.js";
import { ProtectedChromiumManager } from "../../dist/routing/protected-chromium.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  createDeployerModulePackage,
  DEPLOYER_MODULE_ID
} from "../helpers/deployer-module-fixture.mjs";
import { startPerchanceEmulator } from "../helpers/perchance-emulator.mjs";
import { createZip } from "../helpers/zip-fixture.mjs";
import {
  observeSyntheticSocksEgress,
  startSyntheticSocksExit
} from "./synthetic-protected-egress-fixture.mjs";

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
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required");
  return value;
}

async function pcmsFixture(root) {
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
  const browser = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  const driver = new BrowserDriver({
    browserManager: browser,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000
  });
  return { paths, database, lifecycle, browser, driver };
}

async function startRouterControlFixture(root, exitsByRoute) {
  const socketPath = join(root, "router-control.sock");
  const requests = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);

      let payload;
      if (request.command === "prepare_chromium_exit") {
        const selected = exitsByRoute.get(request.route_id);
        payload = selected === undefined
          ? { ok: false, error: "synthetic route not found" }
          : {
              ok: true,
              ready: true,
              route_id: request.route_id,
              relay_ip: request.relay_ip,
              relay_port: request.relay_port,
              local_host: "127.0.0.1",
              local_port: selected.port,
              lease_id: request.lease_id,
              lease_generation: request.lease_generation,
              lease_ttl_seconds: request.lease_ttl_seconds,
              selected_entry: "synthetic"
            };
      } else if (request.command === "release_chromium_exit") {
        payload = { ok: true, released: true };
      } else {
        payload = {
          ok: false,
          error: "unsupported synthetic router command"
        };
      }
      socket.end(`${JSON.stringify({ ...payload, id: request.id })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error)
        );
      });
    }
  };
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting egress CDP verifier")),
      5_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Egress CDP WebSocket connection failed"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 8_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId })
      }));
    });
  }

  async function disconnect() {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      socket.close(1000, "P033 egress verifier detach");
    });
  }

  return { send, disconnect };
}

async function observeBrowserEgress(session, path) {
  const client = await connectCdp(session.devTools.webSocketUrl);
  let targetId;
  let targetSessionId;
  try {
    const created = await client.send("Target.createTarget", {
      url: `http://pcms-egress.invalid${path}`
    });
    targetId = created.targetId;
    const attached = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    targetSessionId = attached.sessionId;

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const evaluated = await client.send(
          "Runtime.evaluate",
          {
            expression: "document.body ? document.body.innerText : ''",
            returnByValue: true
          },
          targetSessionId
        );
        const value = evaluated?.result?.value;
        if (typeof value === "string" && value !== "") {
          try {
            const parsed = JSON.parse(value);
            if (typeof parsed.routeIdentity === "string") {
              return {
                routeIdentity: parsed.routeIdentity,
                checkedAt: Date.now()
              };
            }
          } catch {
            // Navigation may still be committing.
          }
        }
      } catch {
        // Execution context may change during navigation.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for protected browser egress");
  } finally {
    if (targetSessionId !== undefined) {
      await client.send("Target.detachFromTarget", {
        sessionId: targetSessionId
      }).catch(() => undefined);
    }
    if (targetId !== undefined) {
      await client.send("Target.closeTarget", {
        targetId
      }).catch(() => undefined);
    }
    await client.disconnect();
  }
}

function protectedRoutingFixture({ browser, router, exitsByRoute }) {
  let pendingRouteId = null;
  const protectedChromium = new ProtectedChromiumManager({
    router,
    browser,
    verifier: {
      async verifyForwarder(lease) {
        pendingRouteId = lease.routeId;
        const selected = exitsByRoute.get(lease.routeId);
        assert.ok(selected, `missing synthetic exit for ${lease.routeId}`);
        const observed = await observeSyntheticSocksEgress({
          proxyHost: lease.localHost,
          proxyPort: lease.localPort,
          targetPath: `/preflight-${lease.routeId}`
        });
        return {
          routeIdentity: observed.routeIdentity,
          checkedAt: Date.now()
        };
      },
      async verifyBrowser(session) {
        assert.ok(pendingRouteId !== null);
        const routeId = pendingRouteId;
        pendingRouteId = null;
        return observeBrowserEgress(
          session,
          `/browser-${routeId}`
        );
      }
    }
  });
  return new ChromiumRoutingManager({
    browser,
    protectedChromium
  });
}

async function selectLoadedPage(connection, url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const target = (await connection.listPages()).find(
      (candidate) => candidate.url === url
    );
    if (target !== undefined) {
      const page = await connection.selectPage({
        targetId: target.targetId
      });
      const readyState = await page.evaluate("document.readyState");
      if (
        readyState === "complete" ||
        readyState === "interactive"
      ) {
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("routed Perchance emulator page did not become ready");
}

async function resolvedArtifact() {
  const archive = createZip([
    {
      name: "release/index.html",
      data: "<main>P033 routed deployment</main>"
    },
    {
      name: "release/src/app.js",
      data: "export const phase = 'P033';"
    }
  ]);
  const commitSha = "3".repeat(40);
  const treeSha = "4".repeat(40);
  const blobSha = "5".repeat(40);
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

test("P033 routed Account Persona emulator Deployer module vertical slice reconciles response loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-p033-vertical-"));
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "Owner@Example.test",
      sessionToken: "fixture-session-p033-vertical",
      generators: [{
        publicId: "public-p033-vertical",
        slug: "repository-generator"
      }]
    }]
  });
  const emulatorUrl = new URL(emulator.origin);
  const emulatorPort = Number(emulatorUrl.port);
  const routedOrigin =
    `http://pcms-emulator.invalid:${emulatorPort}/`;
  const syntheticExit = await startSyntheticSocksExit({
    routeIdentity: "synthetic-p033-route",
    forwardTarget: {
      requestedHost: "pcms-emulator.invalid",
      requestedPort: emulatorPort,
      connectHost: "127.0.0.1",
      connectPort: emulatorPort
    }
  });
  const exitsByRoute = new Map([
    ["route-p033", syntheticExit]
  ]);
  const routerFixture =
    await startRouterControlFixture(root, exitsByRoute);
  const f = await pcmsFixture(root);
  const router = createNativeRouterClient({
    socketPath: routerFixture.socketPath,
    requestIdFactory: () => "p033-router-request"
  });
  const routing = protectedRoutingFixture({
    browser: f.browser,
    router,
    exitsByRoute
  });
  const personaUid = "persona_p033_vertical";
  let routedSession;
  let connection;
  let moduleRuntime;

  try {
    routedSession = await routing.launch({
      mode: "PROTECTED",
      personaUid,
      routeId: "route-p033",
      relayIp: "10.124.0.33",
      leaseId: "lease-p033",
      leaseGeneration: 1,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-p033-route",
      browser: {
        initialUrl: routedOrigin,
        headless: true,
        disableSandboxForTesting: true
      }
    });
    assert.deepEqual(
      routing.mutationAdmission(personaUid),
      {
        allowed: true,
        mode: "PROTECTED",
        routeId: "route-p033",
        reason: "PROTECTED_VERIFIED"
      }
    );

    connection = await f.driver.connect(personaUid);
    const page = await selectLoadedPage(connection, routedOrigin);
    const browserSession =
      emulator.sessionFor("owner@example.test");
    await page.evaluate(
      `sessionStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(browserSession))})`
    );

    const accounts = new AccountRepository({
      database: f.database
    });
    const bindings = new PersonaBindingService({
      database: f.database
    });
    const generators = new GeneratorRepository({
      database: f.database
    });
    accounts.create({
      accountId: "account_p033_vertical",
      displayName: "P033 Vertical Account"
    });
    bindings.bind({
      accountId: "account_p033_vertical",
      personaUid,
      expectedRevision: 0,
      reason: "P033 routed Deployer vertical slice"
    });
    generators.create({
      generatorLocalId: "generator_p033_vertical",
      accountId: "account_p033_vertical",
      providerStableId: "public-p033-vertical",
      currentSlug: "repository-generator"
    });

    const now = () =>
      new Date("2026-10-03T18:30:00.000Z");
    const provider = new PerchanceProvider({
      browserProfile: {
        sessionStateExpression:
          SESSION_STATE_EXPRESSION
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

    const modules = new ModuleManager(
      f.database,
      {
        packageRoot: join(root, "modules"),
        now
      }
    );
    const installed = await modules.installPackage(
      createDeployerModulePackage("1.0.0")
    );
    const owner = {
      kind: "MODULE",
      moduleId: DEPLOYER_MODULE_ID,
      moduleVersion:
        installed.registration.activeVersion,
      runtimeGeneration:
        installed.registration.runtimeGeneration
    };

    moduleRuntime =
      await modules.startActiveRuntime(
        DEPLOYER_MODULE_ID,
        {
          sdkHandlers: {
            "services.deployer.deploy": async (params) => {
              assert.deepEqual(
                routing.mutationAdmission(personaUid),
                {
                  allowed: true,
                  mode: "PROTECTED",
                  routeId: "route-p033",
                  reason: "PROTECTED_VERIFIED"
                }
              );
              assert.equal(typeof params, "object");
              assert.ok(params !== null);
              const operationId = params.operationId;
              const idempotencyKey =
                params.idempotencyKey;
              assert.equal(
                typeof operationId,
                "string"
              );
              assert.equal(
                typeof idempotencyKey,
                "string"
              );

              const result = await service.deploy({
                page,
                artifact,
                accountId: "account_p033_vertical",
                expectedProviderIdentity:
                  "owner@example.test",
                requiredPublic: true,
                operationId,
                idempotencyKey,
                owner,
                actorSource: "deployer-module",
                mutationCommandOptions: {
                  timeoutMs: 200
                }
              });
              return {
                disposition: result.disposition,
                operationState:
                  result.operation?.state ?? null,
                operationId:
                  result.operation?.operationId ?? null,
                providerStableId:
                  result.target.generator.providerStableId,
                artifactSha256:
                  result.observation.artifactSha256,
                isPublic:
                  result.observation.isPublic
              };
            }
          }
        }
      );

    emulator.setScenario(
      "RESPONSE_LOSS_AFTER_EFFECT"
    );
    const deployed = await moduleRuntime.request(
      "deploy",
      {
        operationId:
          "operation-p033-routed-deploy",
        idempotencyKey:
          "request-p033-routed-deploy"
      }
    );

    assert.deepEqual(deployed, {
      disposition: "RECONCILED_APPLIED",
      operationState: "SUCCEEDED",
      operationId:
        "operation-p033-routed-deploy",
      providerStableId:
        "public-p033-vertical",
      artifactSha256: artifact.sha256,
      isPublic: true
    });

    const observed = emulator.readGenerator(
      "public-p033-vertical"
    );
    assert.equal(
      observed.artifactSha256,
      artifact.sha256
    );
    assert.equal(observed.isPublic, true);

    const providerPaths =
      emulator.requests().map(
        (request) => request.path
      );
    assert.deepEqual(providerPaths, [
      "/api/getGeneratorsByUser",
      "/api/getGeneratorPageData",
      "/api/save",
      "/api/getGeneratorPageData"
    ]);
    assert.ok(
      syntheticExit.forwardedConnections.length >= 1,
      "routed emulator traffic must create at least one protected SOCKS tunnel"
    );
    assert.ok(
      syntheticExit.forwardedConnections.every(
        (entry) =>
          entry.requestedHost ===
            "pcms-emulator.invalid" &&
          entry.requestedPort === emulatorPort
      )
    );
    const routedTraffic =
      syntheticExit.forwardedConnections
        .map((entry) =>
          Buffer.concat(entry.clientChunks)
            .toString("latin1")
        )
        .join("\n");
    const routedApiPaths = [
      ...routedTraffic.matchAll(
        /^POST\s+(\/api\/\S+)\s+HTTP\/1\.[01]\r?$/gmu
      )
    ].map((match) => match[1]);
    assert.deepEqual(
      routedApiPaths,
      providerPaths,
      "every provider API request must be visible inside the protected SOCKS tunnel"
    );
    assert.ok(
      syntheticExit.observations.some(
        (entry) =>
          entry.requestedPath ===
          "/preflight-route-p033"
      )
    );
    assert.ok(
      syntheticExit.observations.some(
        (entry) =>
          entry.requestedPath ===
          "/browser-route-p033"
      )
    );
    assert.equal(
      coordinator.require(
        "operation-p033-routed-deploy"
      ).state,
      "SUCCEEDED"
    );
    assert.equal(
      f.lifecycle.get(personaUid).profileState,
      "OPEN"
    );
  } finally {
    if (moduleRuntime !== undefined) {
      await moduleRuntime.stop().catch(() => undefined);
    }
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (routedSession !== undefined) {
      await routedSession.close();
    }
    f.database.close();
    await routerFixture.close();
    await syntheticExit.close();
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  }
});
