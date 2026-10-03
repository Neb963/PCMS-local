import assert from "node:assert/strict";
import test from "node:test";

import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

async function post(origin, value) {
  const response = await fetch(new URL("/api/getGeneratorsByUser", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    contentType,
    body: contentType.includes("application/json")
      ? await response.json()
      : await response.text()
  };
}

test("P026 Perchance emulator models session, generator drift and named fault scenarios deterministically", async () => {
  const emulator = await startPerchanceEmulator({
    accounts: [
      {
        identity: "Owner@Example.test",
        sessionToken: "fixture-session-owner",
        generators: [
          { publicId: "public-stable-1", slug: "alpha-generator" }
        ]
      },
      {
        identity: "Other@Example.test",
        sessionToken: "fixture-session-other",
        generators: []
      }
    ]
  });

  try {
    const expected = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.equal(expected.status, 200);
    assert.deepEqual(expected.body, {
      status: "success",
      generators: [
        { generatorName: "alpha-generator", publicId: "public-stable-1" }
      ],
      generatorFolderMap: {}
    });

    const mismatch = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-other"
    });
    assert.deepEqual(mismatch.body, { status: "session-token-error" });

    emulator.renameGenerator("public-stable-1", "renamed-generator");
    const renamed = await post(emulator.origin, {
      email: "OWNER@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.deepEqual(renamed.body.generators, [
      { generatorName: "renamed-generator", publicId: "public-stable-1" }
    ]);

    emulator.setScenario("UNKNOWN_STATUS");
    const unknown = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.deepEqual(unknown.body, { status: "synthetic-future-status" });

    emulator.setScenario("MALFORMED_SUCCESS");
    const malformed = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.equal(malformed.body.status, "success");
    assert.equal(typeof malformed.body.generators, "string");

    emulator.setScenario("PERIMETER_HTML");
    const perimeter = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.equal(perimeter.status, 403);
    assert.match(perimeter.contentType, /^text\/html/u);

    emulator.setScenario("HTTP_ERROR");
    const error = await post(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-owner"
    });
    assert.equal(error.status, 503);

    const requests = emulator.requests();
    assert.ok(requests.length >= 7);
    assert.equal(JSON.stringify(requests).includes("fixture-session-owner"), false);
    assert.ok(requests.every((entry) => entry.sessionPresent === true));
  } finally {
    await emulator.close();
  }
});
