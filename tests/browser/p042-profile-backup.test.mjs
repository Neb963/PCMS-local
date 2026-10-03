import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPersonaProfileBackup,
  restorePersonaProfileBackup
} from "../../dist/backup/profile-backup.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  ChromiumBrowserManager
} from "../../dist/personas/chromium-browser.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import {
  applyPcmsMigrations
} from "../../dist/storage/migrations.js";
import {
  openConfiguredSqliteDatabase
} from "../../dist/storage/sqlite.js";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>PCMS P042 profile round trip</title>
<script>
const params = new URLSearchParams(location.search);
const action = params.get("action");
const value = params.get("value");

if (action === "write") {
  localStorage.setItem("pcms.p042.profile-state", value);
  document.cookie =
    "pcms_p042=" + encodeURIComponent(value) + "; Path=/; SameSite=Lax";
}

const cookiePrefix = "pcms_p042=";
const cookie = document.cookie
  .split("; ")
  .find((entry) => entry.startsWith(cookiePrefix));

fetch("/report", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action,
    localStorage: localStorage.getItem("pcms.p042.profile-state"),
    cookie: cookie === undefined
      ? null
      : decodeURIComponent(cookie.slice(cookiePrefix.length))
  })
}).then(() => {
  document.title = "PCMS reported";
}).catch((error) => {
  document.title = "PCMS report failed";
  document.body.textContent = String(error);
});
</script>
<body>PCMS P042 profile backup fixture</body>
`;

function chromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(
    value,
    "PCMS_CHROMIUM_BINARY is required for P042 browser acceptance"
  );
  return value;
}

async function storageServer() {
  const reports = [];
  const waiters = [];

  const server = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`
    );

    if (request.method === "GET" && url.pathname === "/fixture") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(PAGE);
      return;
    }

    if (request.method === "POST" && url.pathname === "/report") {
      const chunks = [];
      let total = 0;
      request.on("data", (chunk) => {
        total += chunk.length;
        if (total > 16 * 1024) {
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const report = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          );
          reports.push(report);
          for (
            let index = waiters.length - 1;
            index >= 0;
            index -= 1
          ) {
            const waiter = waiters[index];
            if (waiter.action === report.action) {
              waiters.splice(index, 1);
              clearTimeout(waiter.timer);
              waiter.resolve(report);
            }
          }
          response.writeHead(204);
          response.end();
        } catch {
          response.writeHead(400);
          response.end();
        }
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    url(action, value) {
      const url = new URL("/fixture", origin);
      url.searchParams.set("action", action);
      if (value !== undefined) {
        url.searchParams.set("value", value);
      }
      return url.href;
    },
    waitFor(action, timeoutMs = 10_000) {
      const existing = reports.find(
        (report) => report.action === action
      );
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          action,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(
              new Error(
                `timed out waiting for P042 browser report ${action}`
              )
            );
          }, timeoutMs)
        };
        waiters.push(waiter);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

async function browserFixture(root) {
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const database = openConfiguredSqliteDatabase(
    paths.databasePath
  );
  applyPcmsMigrations(database);
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot
  });
  const manager = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: chromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { paths, database, lifecycle, manager };
}

test("P042 closed Persona profile round-trips through exact pinned Chromium runtime", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p042-browser-")
  );
  const sourceRoot = join(outer, "source");
  const restoredRoot = join(outer, "restored");
  const backupRoot = join(outer, "profile-backups");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(restoredRoot, { recursive: true });

  const server = await storageServer();
  const source = await browserFixture(sourceRoot);
  let sourceSession;
  let restored;
  let restoredSession;

  try {
    sourceSession = await source.manager.launch(
      "persona-p042-browser",
      {
        headless: true,
        disableSandboxForTesting: true,
        initialUrl: server.url(
          "write",
          "persisted-through-profile-backup"
        )
      }
    );
    const writeReport = await server.waitFor("write");
    assert.deepEqual(writeReport, {
      action: "write",
      localStorage: "persisted-through-profile-backup",
      cookie: "persisted-through-profile-backup"
    });
    const chromiumVersion = sourceSession.browserVersion;
    await sourceSession.close();
    sourceSession = undefined;

    const created = await createPersonaProfileBackup({
      database: source.database,
      personasRoot: source.paths.personasRoot,
      backupRoot,
      personaUid: "persona-p042-browser",
      chromiumVersion
    });
    assert.equal(
      created.manifest.chromiumVersion,
      chromiumVersion
    );

    restored = await browserFixture(restoredRoot);
    const restoredProfile = await restorePersonaProfileBackup({
      backupDirectory: created.directory,
      destinationPersonasRoot: restored.paths.personasRoot,
      expectedPersonaUid: "persona-p042-browser",
      chromiumVersion
    });
    assert.equal(restoredProfile.status, "RESTORED");
    assert.equal(
      restoredProfile.compatibility.reason,
      "EXACT_RUNTIME_MATCH"
    );

    const timestamp = "2026-10-04T01:00:00.000Z";
    restored.database.prepare(`
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
        'persona-p042-browser',
        'ACTIVE',
        'CLOSED',
        'chromium-v1',
        'personas/persona-p042-browser/chromium',
        'PRESENT',
        NULL,
        NULL,
        ?,
        ?,
        NULL,
        0
      )
    `).run(timestamp, timestamp);

    restoredSession = await restored.manager.launch(
      "persona-p042-browser",
      {
        headless: true,
        disableSandboxForTesting: true,
        initialUrl: server.url("read")
      }
    );
    assert.equal(
      restoredSession.browserVersion,
      chromiumVersion
    );
    const readReport = await server.waitFor("read");
    assert.deepEqual(readReport, {
      action: "read",
      localStorage: "persisted-through-profile-backup",
      cookie: "persisted-through-profile-backup"
    });
  } finally {
    if (restoredSession !== undefined) {
      await restoredSession.close();
    }
    if (sourceSession !== undefined) {
      await sourceSession.close();
    }
    restored?.database.close();
    source.database.close();
    await server.close();
    await rm(outer, { recursive: true, force: true });
  }
});
