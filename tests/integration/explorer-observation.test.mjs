import assert from "node:assert/strict";
import test from "node:test";

import {
  ExplorerObservationLedger,
  ExplorerObservationService
} from "../../dist/explorer/observation.js";
import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

function remote(emulator) {
  return {
    async readAvailability(slug) {
      const response = await fetch(
        new URL(
          "/__pcms_emulator__/explorer/availability?slug=" +
            encodeURIComponent(slug),
          emulator.origin
        )
      );
      assert.equal(response.status, 200);
      return response.json();
    }
  };
}

test("P037 Explorer availability observations stay distinct from ownership", async () => {
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: ["open-name"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037",
      generators: [{
        publicId: "public-existing",
        slug: "taken-name",
        isPublic: true
      }]
    }]
  });
  let nowMs = Date.parse("2026-10-03T20:00:00.000Z");
  const history = new ExplorerObservationLedger();
  const service = new ExplorerObservationService({
    history,
    now: () => new Date(nowMs)
  });

  try {
    const available = await service.observe({
      candidateId: "candidate-open",
      slug: "open-name",
      remote: remote(emulator)
    });
    assert.equal(available.availability, "AVAILABLE");
    assert.equal(available.ownership, "UNVERIFIED");
    assert.equal(available.compatibility, "VERIFIED");

    nowMs += 1_000;
    const unavailable = await service.observe({
      candidateId: "candidate-taken",
      slug: "taken-name",
      remote: remote(emulator)
    });
    assert.equal(unavailable.availability, "UNAVAILABLE");
    assert.equal(unavailable.ownership, "UNVERIFIED");

    emulator.setScenario("COMPATIBILITY_DRIFT");
    nowMs += 1_000;
    const drifted = await service.observe({
      candidateId: "candidate-open",
      slug: "open-name",
      remote: remote(emulator)
    });
    assert.equal(drifted.availability, "UNKNOWN");
    assert.equal(drifted.ownership, "UNVERIFIED");
    assert.equal(drifted.compatibility, "UNKNOWN");

    assert.deepEqual(
      history.list("candidate-open").map((record) => ({
        availability: record.availability,
        ownership: record.ownership
      })),
      [
        { availability: "AVAILABLE", ownership: "UNVERIFIED" },
        { availability: "UNKNOWN", ownership: "UNVERIFIED" }
      ]
    );
    assert.equal(
      history.snapshot().candidates["candidate-open"]?.length,
      2
    );
  } finally {
    await emulator.close();
  }
});
