import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePerchancePublicListingContract,
  decodePerchanceRecentObservationContract,
  decodePerchanceRefreshEffectContract
} from "../../dist/providers/perchance-refresh-contract.js";
import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

const OBSERVED_AT = "2026-10-03T19:00:00.000Z";

async function getJson(origin, path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  return response.json();
}

test("P034 listing and recent contracts stay semantically distinct and fail closed on drift", async () => {
  const emulator = await startPerchanceEmulator({
    recentPublicIds: ["public-recent"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p034-contract",
      generators: [
        {
          publicId: "public-recent",
          slug: "recent-generator",
          isPublic: true
        },
        {
          publicId: "public-library-only",
          slug: "library-generator",
          isPublic: true
        }
      ]
    }]
  });

  try {
    const listingRaw = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/public-listing"
    );
    const recentRaw = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/recent"
    );

    const listing = decodePerchancePublicListingContract(
      listingRaw,
      OBSERVED_AT
    );
    assert.equal(listing.compatibility, "VERIFIED");
    assert.equal(listing.semantic, "PUBLIC_LIBRARY");
    assert.equal(listing.complete, true);
    assert.deepEqual(
      listing.items.map((item) => item.publicId),
      ["public-library-only", "public-recent"]
    );

    const recent = decodePerchanceRecentObservationContract(
      recentRaw,
      OBSERVED_AT
    );
    assert.equal(recent.compatibility, "VERIFIED");
    assert.equal(recent.semantic, "RECENTLY_UPDATED");
    assert.equal(recent.complete, true);
    assert.equal(recent.credibleAbsence, true);
    assert.deepEqual(
      recent.items.map((item) => item.publicId),
      ["public-recent"]
    );

    const listingAsRecent =
      decodePerchanceRecentObservationContract(
        listingRaw,
        OBSERVED_AT
      );
    assert.deepEqual(listingAsRecent, {
      semantic: "RECENTLY_UPDATED",
      compatibility: "UNKNOWN",
      reasonCode: "PROVIDER_SEMANTICS_UNKNOWN",
      complete: false,
      credibleAbsence: false,
      observedSlotCount: null,
      items: [],
      observedAt: OBSERVED_AT
    });

    const recentAsListing =
      decodePerchancePublicListingContract(
        recentRaw,
        OBSERVED_AT
      );
    assert.equal(recentAsListing.compatibility, "UNKNOWN");
    assert.equal(
      recentAsListing.reasonCode,
      "PROVIDER_SEMANTICS_UNKNOWN"
    );

    emulator.setRecentObservationComplete(false);
    const partial = decodePerchanceRecentObservationContract(
      await getJson(
        emulator.origin,
        "/__pcms_emulator__/observations/recent"
      ),
      OBSERVED_AT
    );
    assert.equal(partial.compatibility, "VERIFIED");
    assert.equal(partial.complete, false);
    assert.equal(partial.credibleAbsence, false);
    assert.deepEqual(
      partial.items.map((item) => item.publicId),
      ["public-recent"]
    );

    emulator.setScenario("COMPATIBILITY_DRIFT");
    const driftedListing =
      decodePerchancePublicListingContract(
        await getJson(
          emulator.origin,
          "/__pcms_emulator__/observations/public-listing"
        ),
        OBSERVED_AT
      );
    const driftedRecent =
      decodePerchanceRecentObservationContract(
        await getJson(
          emulator.origin,
          "/__pcms_emulator__/observations/recent"
        ),
        OBSERVED_AT
      );

    assert.equal(driftedListing.compatibility, "UNKNOWN");
    assert.equal(driftedListing.complete, false);
    assert.deepEqual(driftedListing.items, []);

    assert.equal(driftedRecent.compatibility, "UNKNOWN");
    assert.equal(driftedRecent.complete, false);
    assert.equal(driftedRecent.credibleAbsence, false);
    assert.equal(driftedRecent.observedSlotCount, null);
    assert.deepEqual(driftedRecent.items, []);
  } finally {
    await emulator.close();
  }
});

test("P034 refresh-effect decoder distinguishes save confirmation from later recent visibility", async () => {
  const pending = decodePerchanceRefreshEffectContract({
    contractVersion: 1,
    semantic: "REFRESH_EFFECT",
    state: "PENDING",
    publicId: "public-refresh",
    markerStrategyId: "PCMS_MARKER_BOTH_V1",
    refreshToken: "refresh-42",
    refreshSequence: 7,
    recentRank: null
  }, OBSERVED_AT);
  assert.deepEqual(pending, {
    semantic: "REFRESH_EFFECT",
    compatibility: "VERIFIED",
    reasonCode: "REFRESH_EFFECT_VERIFIED",
    state: "PENDING",
    publicId: "public-refresh",
    markerStrategyId: "PCMS_MARKER_BOTH_V1",
    refreshToken: "refresh-42",
    refreshSequence: 7,
    recentRank: null,
    observedAt: OBSERVED_AT
  });

  const visible = decodePerchanceRefreshEffectContract({
    contractVersion: 1,
    semantic: "REFRESH_EFFECT",
    state: "VISIBLE",
    publicId: "public-refresh",
    markerStrategyId: "PCMS_MARKER_BOTH_V1",
    refreshToken: "refresh-42",
    refreshSequence: 7,
    recentRank: 0
  }, OBSERVED_AT);
  assert.equal(visible.compatibility, "VERIFIED");
  assert.equal(visible.state, "VISIBLE");
  assert.equal(visible.recentRank, 0);

  const unknown = decodePerchanceRefreshEffectContract({
    contractVersion: 2,
    semantic: "REFRESH_EFFECT",
    state: "VISIBLE",
    publicId: "public-refresh"
  }, OBSERVED_AT);
  assert.deepEqual(unknown, {
    semantic: "REFRESH_EFFECT",
    compatibility: "UNKNOWN",
    reasonCode: "PROVIDER_PROTOCOL_UNKNOWN",
    state: "UNKNOWN",
    publicId: null,
    markerStrategyId: null,
    refreshToken: null,
    refreshSequence: null,
    recentRank: null,
    observedAt: OBSERVED_AT
  });
});
