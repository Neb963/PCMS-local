import assert from "node:assert/strict";
import test from "node:test";

import {
  PcmsApiError,
  createPcmsApiClient
} from "../../dist/client/api-client.js";

test("typed API client sends bearer authorization and validates status", async () => {
  const token = "a".repeat(43);
  const client = createPcmsApiClient({
    origin: "http://127.0.0.1:17380",
    token,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:17380/api/v1/status");
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      return new Response(JSON.stringify({
        service: "pcmsd",
        status: "ready",
        version: "0.0.0",
        baseline: "0.1",
        database: {
          status: "ok",
          schemaVersion: 1
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(await client.status(), {
    service: "pcmsd",
    status: "ready",
    version: "0.0.0",
    baseline: "0.1",
    database: {
      status: "ok",
      schemaVersion: 1
    }
  });
});

test("typed API client rejects malformed success payloads", async () => {
  const client = createPcmsApiClient({
    origin: "http://127.0.0.1:17380",
    token: "a".repeat(43),
    fetchImpl: async () => new Response(JSON.stringify({ status: "ready" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    () => client.status(),
    (error) => error instanceof PcmsApiError && error.code === "INVALID_API_RESPONSE"
  );
});

test("typed API client refuses non-loopback origins", () => {
  assert.throws(
    () => createPcmsApiClient({
      origin: "http://example.com:17380",
      token: "a".repeat(43)
    }),
    (error) => error instanceof PcmsApiError && error.code === "INVALID_API_ORIGIN"
  );
});
