import { createServer } from "node:http";

export const PERCHANCE_EMULATOR_SCENARIOS = Object.freeze([
  "NORMAL",
  "UNKNOWN_STATUS",
  "MALFORMED_SUCCESS",
  "PERIMETER_HTML",
  "HTTP_ERROR",
  "RESPONSE_LOSS_AFTER_EFFECT",
  "CHALLENGE"
]);

const MAX_REQUEST_BYTES = 16 * 1024;

function asciiLowercase(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function assertText(value, label, maxLength = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(label + " must be a non-empty bounded string");
  }
}

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error("request-too-large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("request-empty");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizedGenerator(generator) {
  assertText(generator.publicId, "generator publicId", 256);
  assertText(generator.slug, "generator slug", 512);
  return {
    publicId: generator.publicId,
    slug: generator.slug
  };
}

function normalizedAccount(account) {
  assertText(account.identity, "account identity", 320);
  assertText(account.sessionToken, "session token", 4096);
  if (!Array.isArray(account.generators)) {
    throw new TypeError("account generators must be an array");
  }
  return {
    identity: account.identity,
    comparisonKey: asciiLowercase(account.identity),
    sessionToken: account.sessionToken,
    generators: account.generators.map(normalizedGenerator)
  };
}

export async function startPerchanceEmulator(options = {}) {
  const accounts = new Map();
  const sessions = new Map();
  const inputAccounts = options.accounts ?? [];

  for (const rawAccount of inputAccounts) {
    const account = normalizedAccount(rawAccount);
    if (accounts.has(account.comparisonKey)) {
      throw new Error("duplicate emulator account identity");
    }
    if (sessions.has(account.sessionToken)) {
      throw new Error("duplicate emulator session token");
    }
    accounts.set(account.comparisonKey, account);
    sessions.set(account.sessionToken, account.comparisonKey);
  }

  let scenario = "NORMAL";
  const requestLog = [];

  function findGenerator(publicId) {
    for (const account of accounts.values()) {
      const generator = account.generators.find((candidate) =>
        candidate.publicId === publicId
      );
      if (generator !== undefined) {
        return generator;
      }
    }
    throw new Error("emulator generator " + publicId + " does not exist");
  }

  function renameGenerator(publicId, newSlug) {
    assertText(newSlug, "new generator slug", 512);
    findGenerator(publicId).slug = newSlug;
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && requestUrl.pathname === "/") {
      const body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>PCMS Perchance Emulator</title></head><body>PCMS Perchance Emulator</body></html>";
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
      });
      response.end(body);
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/challenge"
    ) {
      requestLog.push(Object.freeze({
        method: "GET",
        path: "/__pcms_emulator__/challenge",
        scenario
      }));
      jsonResponse(
        response,
        200,
        scenario === "CHALLENGE"
          ? {
              kind: "CAPTCHA",
              challengeId: "synthetic-challenge-1"
            }
          : null
      );
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/__pcms_emulator__/renameGenerator"
    ) {
      let payload;
      try {
        payload = await readJson(request);
      } catch {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("invalid request");
        return;
      }

      const publicId =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.publicId
          : undefined;
      const newSlug =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.newSlug
          : undefined;
      if (typeof publicId !== "string" || typeof newSlug !== "string") {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("invalid mutation");
        return;
      }

      requestLog.push(Object.freeze({
        method: "POST",
        path: "/__pcms_emulator__/renameGenerator",
        publicId,
        newSlug,
        scenario
      }));
      renameGenerator(publicId, newSlug);

      if (scenario === "RESPONSE_LOSS_AFTER_EFFECT") {
        // Commit the effect, then withhold the response long enough for the
        // BrowserDriver command to time out. Unlike a TCP reset this does not
        // invite Chromium to replay the POST at the transport layer.
        setTimeout(() => {
          if (!response.destroyed) {
            jsonResponse(response, 200, { status: "success" });
          }
        }, 1_000);
        return;
      }
      jsonResponse(response, 200, { status: "success" });
      return;
    }

    if (
      request.method !== "POST" ||
      requestUrl.pathname !== "/api/getGeneratorsByUser"
    ) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("invalid request");
      return;
    }

    const email =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload.email
        : undefined;
    const sessionToken =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload.sessionToken
        : undefined;

    requestLog.push(Object.freeze({
      method: "POST",
      path: "/api/getGeneratorsByUser",
      email: typeof email === "string" ? email : null,
      sessionPresent: typeof sessionToken === "string" && sessionToken.length > 0,
      scenario
    }));

    if (scenario === "PERIMETER_HTML") {
      const body = "<!doctype html><html><title>synthetic perimeter</title></html>";
      response.writeHead(403, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
      });
      response.end(body);
      return;
    }
    if (scenario === "HTTP_ERROR") {
      jsonResponse(response, 503, { status: "synthetic-emulator-error" });
      return;
    }
    if (scenario === "UNKNOWN_STATUS") {
      jsonResponse(response, 200, { status: "synthetic-future-status" });
      return;
    }
    if (scenario === "MALFORMED_SUCCESS") {
      jsonResponse(response, 200, {
        status: "success",
        generators: "synthetic-malformed-list"
      });
      return;
    }

    const accountKey =
      typeof sessionToken === "string" ? sessions.get(sessionToken) : undefined;
    const suppliedKey =
      typeof email === "string" ? asciiLowercase(email) : null;

    if (
      accountKey === undefined ||
      suppliedKey === null ||
      suppliedKey !== accountKey
    ) {
      jsonResponse(response, 200, { status: "session-token-error" });
      return;
    }

    const account = accounts.get(accountKey);
    if (account === undefined) {
      jsonResponse(response, 200, { status: "session-token-error" });
      return;
    }

    jsonResponse(response, 200, {
      status: "success",
      generators: account.generators.map((generator) => ({
        generatorName: generator.slug,
        publicId: generator.publicId
      })),
      generatorFolderMap: {}
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Perchance emulator did not bind an IPv4 loopback port");
  }

  function requireScenario(value) {
    if (!PERCHANCE_EMULATOR_SCENARIOS.includes(value)) {
      throw new Error("unknown Perchance emulator scenario");
    }
  }

  return Object.freeze({
    origin: "http://127.0.0.1:" + address.port + "/",
    setScenario(value) {
      requireScenario(value);
      scenario = value;
    },
    renameGenerator(publicId, newSlug) {
      renameGenerator(publicId, newSlug);
    },
    replaceGeneratorStableId(publicId, replacementPublicId) {
      assertText(replacementPublicId, "replacement publicId", 256);
      findGenerator(publicId).publicId = replacementPublicId;
    },
    sessionFor(identity) {
      const account = accounts.get(asciiLowercase(identity));
      if (account === undefined) {
        throw new Error("emulator account does not exist");
      }
      return Object.freeze({
        identity: account.identity,
        sessionToken: account.sessionToken
      });
    },
    requests() {
      return requestLog.map((entry) => ({ ...entry }));
    },
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });
}
