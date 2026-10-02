import assert from "node:assert/strict";
import test from "node:test";

import {
  ModuleAuthorityError,
  computeModuleAuthorityDelta,
  emptyModuleAuthorityEnvelope,
  moduleAuthorityEnvelopeFromManifest,
  normalizeModuleAuthorityEnvelope,
  parseSerializedModuleAuthorityEnvelope,
  serializeModuleAuthorityEnvelope
} from "../../dist/modules/authority.js";
import { parseModuleManifest } from "../../dist/modules/manifest.js";

function manifest(overrides = {}) {
  return parseModuleManifest({
    schemaVersion: 1,
    id: "fixture.authority",
    name: "Authority Fixture",
    version: "1.0.0",
    pcmsApi: ">=1.0.0 <2.0.0",
    backend: "backend/index.mjs",
    capabilities: ["accounts.read", "provider.read"],
    services: {
      requires: ["fixture.service@1"],
      provides: ["fixture.provided@1"]
    },
    stateSchemaVersion: 1,
    ...overrides
  });
}

test("canonicalizes manifest authority without treating provided services as authority", () => {
  const envelope = moduleAuthorityEnvelopeFromManifest(manifest());
  assert.deepEqual(envelope, {
    capabilities: ["accounts.read", "provider.read"],
    requiredServices: ["fixture.service@1"]
  });
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.capabilities), true);
});

test("initial authority is an expansion from the empty envelope", () => {
  const requested = moduleAuthorityEnvelopeFromManifest(manifest());
  const delta = computeModuleAuthorityDelta(null, requested);

  assert.deepEqual(delta.addedCapabilities, [
    "accounts.read",
    "provider.read"
  ]);
  assert.deepEqual(delta.addedRequiredServices, [
    "fixture.service@1"
  ]);
  assert.deepEqual(delta.removedCapabilities, []);
  assert.deepEqual(delta.removedRequiredServices, []);
  assert.equal(delta.expands, true);
});

test("update delta distinguishes expansions from equal and reduced authority", () => {
  const current = normalizeModuleAuthorityEnvelope({
    capabilities: [
      "accounts.read",
      "provider.read",
      "provider.mutate"
    ],
    requiredServices: ["fixture.service@1"]
  });

  const equal = computeModuleAuthorityDelta(current, current);
  assert.equal(equal.expands, false);
  assert.deepEqual(equal.addedCapabilities, []);
  assert.deepEqual(equal.removedCapabilities, []);

  const reduced = computeModuleAuthorityDelta(
    current,
    normalizeModuleAuthorityEnvelope({
      capabilities: ["accounts.read"],
      requiredServices: []
    })
  );
  assert.equal(reduced.expands, false);
  assert.deepEqual(reduced.removedCapabilities, [
    "provider.mutate",
    "provider.read"
  ]);
  assert.deepEqual(reduced.removedRequiredServices, [
    "fixture.service@1"
  ]);

  const expanded = computeModuleAuthorityDelta(
    current,
    normalizeModuleAuthorityEnvelope({
      capabilities: [
        "accounts.read",
        "provider.read",
        "provider.mutate",
        "secrets.use:deploy"
      ],
      requiredServices: [
        "fixture.other@2",
        "fixture.service@1"
      ]
    })
  );
  assert.equal(expanded.expands, true);
  assert.deepEqual(expanded.addedCapabilities, [
    "secrets.use:deploy"
  ]);
  assert.deepEqual(expanded.addedRequiredServices, [
    "fixture.other@2"
  ]);
});

test("authority serialization is canonical and rejects invalid persisted data", () => {
  const envelope = normalizeModuleAuthorityEnvelope({
    capabilities: ["provider.read", "accounts.read", "accounts.read"],
    requiredServices: ["fixture.service@1"]
  });
  const serialized = serializeModuleAuthorityEnvelope(envelope);
  assert.equal(
    serialized,
    '{"capabilities":["accounts.read","provider.read"],"requiredServices":["fixture.service@1"]}'
  );
  assert.deepEqual(
    parseSerializedModuleAuthorityEnvelope(serialized),
    envelope
  );

  assert.deepEqual(emptyModuleAuthorityEnvelope(), {
    capabilities: [],
    requiredServices: []
  });
  assert.throws(
    () =>
      normalizeModuleAuthorityEnvelope({
        capabilities: ["db.raw"],
        requiredServices: []
      }),
    ModuleAuthorityError
  );
  assert.throws(
    () => parseSerializedModuleAuthorityEnvelope('{"capabilities":[]}'),
    ModuleAuthorityError
  );
});
