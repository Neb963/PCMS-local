import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChromiumBrowserManager
} from "../../dist/personas/chromium-browser.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>PCMS P013 storage fixture</title>
<script>
const params = new URLSearchParams(location.search);
const persona = params.get("persona");
const action = params.get("action");
const value = params.get("value");

function cookieValue() {
  const prefix = "pcms_auth=";
  const entry = document.cookie
    .split("; ")
    .find((item) => item.startsWith(prefix));
  return entry === undefined
    ? null
    : decodeURIComponent(entry.slice(prefix.length));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pcms-p013-storage", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("state");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function readIndexed(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("state", "readonly");
    const request = transaction.objectStore("state").get("identity");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? null);
  });
}

function writeIndexed(database, nextValue) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(nextValue, "identity");
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

async function snapshot(database) {
  return {
    cookie: cookieValue(),
    localStorage: localStorage.getItem("pcms.identity"),
    indexedDb: await readIndexed(database)
  };
}

(async () => {
  const database = await openDatabase();
  const before = await snapshot(database);

  if (action === "write") {
    document.cookie =
      "pcms_auth=" + encodeURIComponent(value) + "; Path=/; SameSite=Lax";
    localStorage.setItem("pcms.identity", value);
    await writeIndexed(database, value);
  }

  const after = await snapshot(database);
  database.close();

  const response = await fetch("/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona, action, value, before, after })
  });
  if (!response.ok) {
    throw new Error("report failed: " + response.status);
  }
  document.title = "PCMS reported";
})().catch((error) => {
  document.title = "PCMS fixture error";
  document.body.textContent = String(error && error.stack || error);
});
</script>
<body>PCMS browser storage fixture</body>
`;

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(
    value,
    "PCMS_CHROMIUM_BINARY is required for real-browser acceptance"
  );
  return value;
}

async function createBrowserFixture(prefix) {
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
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { root, paths, database, lifecycle, manager };
}

async function createStorageServer() {
  const reports = [];
  const waiters = [];

  function publish(report) {
    reports.push(report);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (
        waiter.persona === report.persona &&
        waiter.action === report.action
      ) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(report);
      }
    }
  }

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
        if (total > 32 * 1024) {
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          publish(report);
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
    url(persona, action, value) {
      const url = new URL("/fixture", origin);
      url.searchParams.set("persona", persona);
      url.searchParams.set("action", action);
      if (value !== undefined) {
        url.searchParams.set("value", value);
      }
      return url.href;
    },
    waitFor(persona, action, timeoutMs = 10_000) {
      const existing = reports.find(
        (report) => report.persona === persona && report.action === action
      );
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          persona,
          action,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(
              new Error(
                `timed out waiting for browser report ${persona}/${action}`
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
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  };
}

function emptySnapshot(snapshot) {
  assert.deepEqual(snapshot, {
    cookie: null,
    localStorage: null,
    indexedDb: null
  });
}

function valueSnapshot(snapshot, value) {
  assert.deepEqual(snapshot, {
    cookie: value,
    localStorage: value,
    indexedDb: value
  });
}

test("real Chromium persists browser storage per Persona without cross-Persona sharing", async () => {
  const f = await createBrowserFixture("pcms-chromium-storage-");
  const storage = await createStorageServer();
  let session;

  async function run(persona, action, value) {
    session = await f.manager.launch(persona, {
      headless: true,
      disableSandboxForTesting: true,
      initialUrl: storage.url(persona, action, value)
    });
    const report = await storage.waitFor(persona, action);
    await session.close();
    session = undefined;
    return report;
  }

  try {
    const alphaWrite = await run("persona_alpha", "write", "alpha-secret");
    emptySnapshot(alphaWrite.before);
    valueSnapshot(alphaWrite.after, "alpha-secret");

    const betaWrite = await run("persona_beta", "write", "beta-secret");
    emptySnapshot(betaWrite.before);
    valueSnapshot(betaWrite.after, "beta-secret");

    const alphaRead = await run("persona_alpha", "read");
    valueSnapshot(alphaRead.before, "alpha-secret");
    valueSnapshot(alphaRead.after, "alpha-secret");

    const betaRead = await run("persona_beta", "read");
    valueSnapshot(betaRead.before, "beta-secret");
    valueSnapshot(betaRead.after, "beta-secret");

    assert.notEqual(
      join(f.paths.personasRoot, "persona_alpha", "chromium"),
      join(f.paths.personasRoot, "persona_beta", "chromium")
    );
  } finally {
    if (session !== undefined) {
      await session.close();
    }
    await storage.close();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
