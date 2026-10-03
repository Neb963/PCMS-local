import { createServer } from "node:http";

export const PERCHANCE_EMULATOR_SCENARIOS = Object.freeze([
  "NORMAL",
  "UNKNOWN_STATUS",
  "MALFORMED_SUCCESS",
  "PERIMETER_HTML",
  "HTTP_ERROR",
  "RESPONSE_LOSS_AFTER_EFFECT",
  "CHALLENGE",
  "RATE_LIMIT",
  "COMPATIBILITY_DRIFT"
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

function jsonResponse(response, statusCode, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
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

function normalizedDeploymentFile(file) {
  if (
    file === null ||
    typeof file !== "object" ||
    Array.isArray(file) ||
    typeof file.path !== "string" ||
    file.path.length < 1 ||
    file.path.length > 512 ||
    typeof file.contentBase64 !== "string"
  ) {
    throw new TypeError("generator deployment file is invalid");
  }
  return {
    path: file.path,
    contentBase64: file.contentBase64
  };
}

function refreshMarkerToken(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const pjs = byPath.get("main.pjs");
  const html = byPath.get("index.html");
  if (pjs === undefined || html === undefined) {
    return null;
  }
  let pjsText;
  let htmlText;
  try {
    pjsText = Buffer.from(pjs.contentBase64, "base64").toString("utf8");
    htmlText = Buffer.from(html.contentBase64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const pjsMatches = [...pjsText.matchAll(
    /^[ \t]*\/\/[ \t]*pcms-refresh-marker:v1:([A-Za-z0-9._:-]+)[ \t]*$/gmu
  )];
  const htmlMatches = [...htmlText.matchAll(
    /^[ \t]*<!--[ \t]*pcms-refresh-marker:v1:([A-Za-z0-9._:-]+)[ \t]*-->[ \t]*$/gmu
  )];
  if (
    pjsMatches.length !== 1 ||
    htmlMatches.length !== 1 ||
    pjsMatches[0][1] !== htmlMatches[0][1]
  ) {
    return null;
  }
  return pjsMatches[0][1];
}

function normalizedGenerator(generator) {
  assertText(generator.publicId, "generator publicId", 256);
  assertText(generator.slug, "generator slug", 512);
  const artifactSha256 = generator.artifactSha256 ?? "0".repeat(64);
  if (
    typeof artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256)
  ) {
    throw new TypeError("generator artifactSha256 is invalid");
  }
  const files = (generator.files ?? []).map(normalizedDeploymentFile);
  const isPublic = generator.isPublic ?? false;
  if (typeof isPublic !== "boolean") {
    throw new TypeError("generator isPublic must be boolean");
  }
  return {
    publicId: generator.publicId,
    slug: generator.slug,
    artifactSha256,
    files,
    isPublic,
    refreshToken: null,
    refreshSequence: 0,
    refreshEffectPublished: false
  };
}

function normalizedAccount(account) {
  assertText(account.identity, "account identity", 320);
  assertText(account.sessionToken, "session token", 4096);
  const password = account.password ?? "emulator-password";
  assertText(password, "account password", 4096);
  if (!Array.isArray(account.generators)) {
    throw new TypeError("account generators must be an array");
  }
  return {
    identity: account.identity,
    comparisonKey: asciiLowercase(account.identity),
    sessionToken: account.sessionToken,
    password,
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

  const explorerAvailableSlugs = new Set();
  const configuredExplorerAvailableSlugs =
    options.explorerAvailableSlugs ?? [];
  if (!Array.isArray(configuredExplorerAvailableSlugs)) {
    throw new TypeError("explorerAvailableSlugs must be an array");
  }
  for (const slug of configuredExplorerAvailableSlugs) {
    assertText(slug, "Explorer candidate slug", 512);
    if (explorerAvailableSlugs.has(slug)) {
      throw new Error("duplicate Explorer candidate slug");
    }
    explorerAvailableSlugs.add(slug);
  }

  let scenario = "NORMAL";
  let provisioningSessionSequence = 0;
  let explorerClaimSequence = 0;
  let refreshSequence = 0;
  let recentObservationComplete = true;
  const requestLog = [];
  const recentOrder = [];
  const configuredRecent = options.recentPublicIds ?? [];
  if (!Array.isArray(configuredRecent)) {
    throw new TypeError("recentPublicIds must be an array");
  }
  for (const publicId of configuredRecent) {
    assertText(publicId, "recent publicId", 256);
    if (recentOrder.includes(publicId)) {
      throw new Error("duplicate recent generator");
    }
    recentOrder.push(publicId);
  }

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

  for (const publicId of recentOrder) {
    findGenerator(publicId);
  }

  function publicListingItems() {
    const items = [];
    for (const account of accounts.values()) {
      for (const generator of account.generators) {
        if (generator.isPublic) {
          items.push({
            slug: generator.slug,
            publicId: generator.publicId
          });
        }
      }
    }
    items.sort((left, right) =>
      left.slug.localeCompare(right.slug, "en")
    );
    return items;
  }

  function recentItems() {
    return recentOrder
      .map((publicId) => {
        const generator = findGenerator(publicId);
        return generator.isPublic
          ? { slug: generator.slug, publicId: generator.publicId }
          : null;
      })
      .filter((value) => value !== null);
  }

  function publishRefreshEffect(publicId) {
    const generator = findGenerator(publicId);
    if (generator.refreshToken === null) {
      throw new Error("generator has no pending refresh effect");
    }
    const prior = recentOrder.indexOf(publicId);
    if (prior >= 0) {
      recentOrder.splice(prior, 1);
    }
    recentOrder.unshift(publicId);
    generator.refreshEffectPublished = true;
  }

  function refreshEffectFixture(publicId) {
    const generator = findGenerator(publicId);
    if (generator.refreshToken === null) {
      return {
        contractVersion: 1,
        semantic: "REFRESH_EFFECT",
        state: "NONE",
        publicId: generator.publicId
      };
    }
    const rank = recentItems().findIndex((item) =>
      item.publicId === generator.publicId
    );
    return {
      contractVersion: 1,
      semantic: "REFRESH_EFFECT",
      state: generator.refreshEffectPublished ? "VISIBLE" : "PENDING",
      publicId: generator.publicId,
      markerStrategyId: "PCMS_MARKER_BOTH_V1",
      refreshToken: generator.refreshToken,
      refreshSequence: generator.refreshSequence,
      recentRank: rank < 0 ? null : rank
    };
  }

  function provisioningSessionToken(cookieHeader) {
    if (typeof cookieHeader !== "string") {
      return null;
    }
    for (const part of cookieHeader.split(";")) {
      const [name, ...rawValue] = part.trim().split("=");
      if (name !== "pcms_emulator_session") {
        continue;
      }
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
    return null;
  }

  function provisioningCookie(sessionToken) {
    return "pcms_emulator_session=" +
      encodeURIComponent(sessionToken) +
      "; HttpOnly; Path=/; SameSite=Lax";
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
      requestUrl.pathname === "/__pcms_emulator__/provisioning"
    ) {
      const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>PCMS Provisioning Emulator</title></head>
<body>
  <main id="pcms-provisioning">PCMS Provisioning Emulator</main>
  <script>
    window.pcmsProvisioning = Object.freeze({
      signup(identity, password) {
        return fetch("/__pcms_emulator__/provisioning/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ identity, password })
        }).then((response) => response.json());
      },
      login(identity, password) {
        return fetch("/__pcms_emulator__/provisioning/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ identity, password })
        }).then((response) => response.json());
      },
      session() {
        return fetch("/__pcms_emulator__/provisioning/session", {
          cache: "no-store",
          credentials: "same-origin"
        }).then((response) => response.json());
      }
    });
  </script>
</body>
</html>`;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
      });
      response.end(body);
      return;
    }

    if (
      request.method === "POST" &&
      (
        requestUrl.pathname === "/__pcms_emulator__/provisioning/signup" ||
        requestUrl.pathname === "/__pcms_emulator__/provisioning/login"
      )
    ) {
      let payload;
      try {
        payload = await readJson(request);
      } catch {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8"
        });
        response.end("invalid request");
        return;
      }

      const identity =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.identity
          : undefined;
      const password =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.password
          : undefined;
      requestLog.push(Object.freeze({
        method: "POST",
        path: requestUrl.pathname,
        identity: typeof identity === "string" ? identity : null,
        passwordPresent: typeof password === "string" && password.length > 0,
        scenario
      }));

      if (
        typeof identity !== "string" ||
        identity.length < 1 ||
        identity.length > 320 ||
        typeof password !== "string" ||
        password.length < 1 ||
        password.length > 4096
      ) {
        jsonResponse(response, 200, {
          contractVersion: 1,
          semantic: "PROVISIONING_FLOW",
          status: "invalid-input"
        });
        return;
      }

      const key = asciiLowercase(identity);
      let account = accounts.get(key);
      if (requestUrl.pathname.endsWith("/signup")) {
        if (account !== undefined) {
          jsonResponse(response, 200, {
            contractVersion: 1,
            semantic: "PROVISIONING_FLOW",
            status: "duplicate"
          });
          return;
        }
        provisioningSessionSequence += 1;
        account = normalizedAccount({
          identity,
          password,
          sessionToken:
            "provisioning-session-" + provisioningSessionSequence,
          generators: []
        });
        accounts.set(account.comparisonKey, account);
        sessions.set(account.sessionToken, account.comparisonKey);
      } else if (account === undefined || account.password !== password) {
        jsonResponse(response, 200, {
          contractVersion: 1,
          semantic: "PROVISIONING_FLOW",
          status: "invalid-credentials"
        });
        return;
      }

      jsonResponse(
        response,
        200,
        {
          contractVersion: 1,
          semantic: "PROVISIONING_FLOW",
          status: requestUrl.pathname.endsWith("/signup")
            ? "submitted"
            : "authenticated"
        },
        { "set-cookie": provisioningCookie(account.sessionToken) }
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/provisioning/session"
    ) {
      const token = provisioningSessionToken(request.headers.cookie);
      const key = token === null ? undefined : sessions.get(token);
      const account = key === undefined ? undefined : accounts.get(key);
      requestLog.push(Object.freeze({
        method: "GET",
        path: requestUrl.pathname,
        sessionPresent: token !== null,
        scenario
      }));
      jsonResponse(response, 200, {
        contractVersion: 1,
        semantic: "PROVISIONING_SESSION",
        authenticated: account !== undefined,
        identity: account?.identity ?? null
      });
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/observations/public-listing"
    ) {
      requestLog.push(Object.freeze({
        method: "GET",
        path: requestUrl.pathname,
        scenario
      }));
      jsonResponse(
        response,
        200,
        scenario === "COMPATIBILITY_DRIFT"
          ? {
              contractVersion: 2,
              semantic: "FUTURE_LIBRARY_SHAPE",
              payload: { count: publicListingItems().length }
            }
          : {
              contractVersion: 1,
              semantic: "PUBLIC_LIBRARY",
              complete: true,
              items: publicListingItems()
            }
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/observations/recent"
    ) {
      requestLog.push(Object.freeze({
        method: "GET",
        path: requestUrl.pathname,
        scenario
      }));
      const items = recentItems();
      jsonResponse(
        response,
        200,
        scenario === "COMPATIBILITY_DRIFT"
          ? {
              contractVersion: 1,
              semantic: "RECENTLY_UPDATED",
              complete: "future-completeness",
              entries: items
            }
          : {
              contractVersion: 1,
              semantic: "RECENTLY_UPDATED",
              complete: recentObservationComplete,
              observedSlotCount: items.length,
              items
            }
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/observations/refresh-effect"
    ) {
      const publicId = requestUrl.searchParams.get("publicId");
      requestLog.push(Object.freeze({
        method: "GET",
        path: requestUrl.pathname,
        publicId,
        scenario
      }));
      if (publicId === null) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8"
        });
        response.end("missing publicId");
        return;
      }
      jsonResponse(
        response,
        200,
        scenario === "COMPATIBILITY_DRIFT"
          ? {
              contractVersion: 99,
              semantic: "REFRESH_EFFECT_VNEXT",
              publicId
            }
          : refreshEffectFixture(publicId)
      );
      return;
    }

    if (
      request.method === "GET" &&
      requestUrl.pathname === "/__pcms_emulator__/explorer/availability"
    ) {
      const slug = requestUrl.searchParams.get("slug");
      requestLog.push(Object.freeze({
        method: "GET",
        path: requestUrl.pathname,
        slug,
        scenario
      }));
      if (slug === null || slug.length < 1 || slug.length > 512) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8"
        });
        response.end("invalid slug");
        return;
      }

      const occupied = [...accounts.values()].some((account) =>
        account.generators.some((generator) => generator.slug === slug)
      );
      jsonResponse(
        response,
        200,
        scenario === "COMPATIBILITY_DRIFT"
          ? {
              contractVersion: 2,
              semantic: "EXPLORER_AVAILABILITY_VNEXT",
              candidate: slug
            }
          : {
              contractVersion: 1,
              semantic: "EXPLORER_AVAILABILITY",
              slug,
              available:
                explorerAvailableSlugs.has(slug) && !occupied
            }
      );
      return;
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/__pcms_emulator__/explorer/claim"
    ) {
      let payload;
      try {
        payload = await readJson(request);
      } catch {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8"
        });
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
      const slug =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.slug
          : undefined;

      requestLog.push(Object.freeze({
        method: "POST",
        path: requestUrl.pathname,
        email: typeof email === "string" ? email : null,
        slug: typeof slug === "string" ? slug : null,
        sessionPresent:
          typeof sessionToken === "string" && sessionToken.length > 0,
        scenario
      }));

      const accountKey =
        typeof sessionToken === "string" ? sessions.get(sessionToken) : undefined;
      const suppliedKey =
        typeof email === "string" ? asciiLowercase(email) : null;
      if (
        accountKey === undefined ||
        suppliedKey === null ||
        suppliedKey !== accountKey ||
        typeof slug !== "string" ||
        slug.length < 1 ||
        slug.length > 512
      ) {
        jsonResponse(response, 200, { status: "session-token-error" });
        return;
      }

      const account = accounts.get(accountKey);
      if (account === undefined) {
        jsonResponse(response, 200, { status: "session-token-error" });
        return;
      }
      const occupied = [...accounts.values()].some((candidateAccount) =>
        candidateAccount.generators.some((generator) =>
          generator.slug === slug
        )
      );
      if (!explorerAvailableSlugs.has(slug) || occupied) {
        jsonResponse(response, 200, { status: "unavailable" });
        return;
      }

      explorerAvailableSlugs.delete(slug);
      explorerClaimSequence += 1;
      const generator = normalizedGenerator({
        publicId: "explorer-claim-" + explorerClaimSequence,
        slug,
        isPublic: false
      });
      account.generators.push(generator);

      if (scenario === "RESPONSE_LOSS_AFTER_EFFECT") {
        setTimeout(() => {
          if (!response.destroyed) {
            jsonResponse(response, 200, {
              status: "claimed",
              publicId: generator.publicId
            });
          }
        }, 1_000);
        return;
      }

      jsonResponse(response, 200, {
        status: "claimed",
        publicId: generator.publicId
      });
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
      request.method === "POST" &&
      (
        requestUrl.pathname === "/api/save" ||
        requestUrl.pathname === "/api/getGeneratorPageData"
      )
    ) {
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
      const publicId =
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload.publicId
          : undefined;

      requestLog.push(Object.freeze({
        method: "POST",
        path: requestUrl.pathname,
        email: typeof email === "string" ? email : null,
        publicId: typeof publicId === "string" ? publicId : null,
        sessionPresent:
          typeof sessionToken === "string" && sessionToken.length > 0,
        scenario
      }));

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
      const generator =
        account?.generators.find((candidate) => candidate.publicId === publicId);
      if (generator === undefined) {
        jsonResponse(response, 200, { status: "generator-does-not-exist" });
        return;
      }

      if (requestUrl.pathname === "/api/getGeneratorPageData") {
        jsonResponse(response, 200, {
          status: "success",
          publicId: generator.publicId,
          slug: generator.slug,
          artifactSha256: generator.artifactSha256,
          files: generator.files.map((file) => ({ ...file })),
          isPublic: generator.isPublic
        });
        return;
      }

      if (scenario === "CHALLENGE") {
        jsonResponse(response, 200, { status: "captcha-needed" });
        return;
      }
      if (scenario === "RATE_LIMIT") {
        jsonResponse(response, 200, { status: "too-many-requests" });
        return;
      }
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
        jsonResponse(response, 503, { status: "server-error" });
        return;
      }
      if (scenario === "UNKNOWN_STATUS") {
        jsonResponse(response, 200, { status: "future-save-status" });
        return;
      }

      const slug = payload.slug;
      const artifactSha256 = payload.artifactSha256;
      const files = payload.files;
      const isPublic = payload.isPublic;
      if (
        slug !== generator.slug ||
        typeof artifactSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(artifactSha256) ||
        !Array.isArray(files) ||
        files.length < 1 ||
        typeof isPublic !== "boolean"
      ) {
        jsonResponse(response, 200, { status: "stale" });
        return;
      }
      let normalizedFiles;
      try {
        normalizedFiles = files.map(normalizedDeploymentFile);
      } catch {
        jsonResponse(response, 200, { status: "too-big" });
        return;
      }
      generator.artifactSha256 = artifactSha256;
      generator.files = normalizedFiles;
      generator.isPublic = isPublic;
      const refreshToken = refreshMarkerToken(normalizedFiles);
      if (
        refreshToken !== null &&
        refreshToken !== generator.refreshToken
      ) {
        refreshSequence += 1;
        generator.refreshToken = refreshToken;
        generator.refreshSequence = refreshSequence;
        generator.refreshEffectPublished = false;
      }

      if (scenario === "RESPONSE_LOSS_AFTER_EFFECT") {
        setTimeout(() => {
          if (!response.destroyed) {
            jsonResponse(response, 200, {
              status: "saved",
              publicId: generator.publicId
            });
          }
        }, 1_000);
        return;
      }
      jsonResponse(response, 200, {
        status: "saved",
        publicId: generator.publicId
      });
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
    publishRefreshEffect(publicId) {
      publishRefreshEffect(publicId);
    },
    setRecentObservationComplete(value) {
      if (typeof value !== "boolean") {
        throw new TypeError("recent observation completeness must be boolean");
      }
      recentObservationComplete = value;
    },
    readRefreshEffect(publicId) {
      return Object.freeze({ ...refreshEffectFixture(publicId) });
    },
    replaceGeneratorStableId(publicId, replacementPublicId) {
      assertText(replacementPublicId, "replacement publicId", 256);
      findGenerator(publicId).publicId = replacementPublicId;
    },
    readGenerator(publicId) {
      const generator = findGenerator(publicId);
      return Object.freeze({
        publicId: generator.publicId,
        slug: generator.slug,
        artifactSha256: generator.artifactSha256,
        files: Object.freeze(
          generator.files.map((file) => Object.freeze({ ...file }))
        ),
        isPublic: generator.isPublic
      });
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
