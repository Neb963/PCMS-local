import assert from "node:assert/strict";
import test from "node:test";

import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

function file(path, content) {
  return {
    path,
    contentBase64: Buffer.from(content, "utf8").toString("base64")
  };
}

async function getJson(origin, path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/u
  );
  return response.json();
}

async function saveRefresh(origin, value) {
  const response = await fetch(new URL("/api/save", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("P034 emulator keeps refresh save and recent-page effect as separate explicit contract states", async () => {
  const emulator = await startPerchanceEmulator({
    recentPublicIds: ["public-recent-existing"],
    accounts: [{
      identity: "Owner@Example.test",
      sessionToken: "fixture-session-p034",
      generators: [
        {
          publicId: "public-refresh-target",
          slug: "refresh-target",
          isPublic: true
        },
        {
          publicId: "public-recent-existing",
          slug: "recent-existing",
          isPublic: true
        },
        {
          publicId: "private-generator",
          slug: "private-generator",
          isPublic: false
        }
      ]
    }]
  });

  try {
    const listingBefore = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/public-listing"
    );
    assert.deepEqual(listingBefore, {
      contractVersion: 1,
      semantic: "PUBLIC_LIBRARY",
      complete: true,
      items: [
        {
          slug: "recent-existing",
          publicId: "public-recent-existing"
        },
        {
          slug: "refresh-target",
          publicId: "public-refresh-target"
        }
      ]
    });

    const recentBefore = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/recent"
    );
    assert.deepEqual(recentBefore, {
      contractVersion: 1,
      semantic: "RECENTLY_UPDATED",
      complete: true,
      observedSlotCount: 1,
      items: [{
        slug: "recent-existing",
        publicId: "public-recent-existing"
      }]
    });

    const saved = await saveRefresh(emulator.origin, {
      email: "owner@example.test",
      sessionToken: "fixture-session-p034",
      publicId: "public-refresh-target",
      slug: "refresh-target",
      artifactSha256: "a".repeat(64),
      files: [
        file(
          "main.pjs",
          "title = Refresh target\n// pcms-refresh-marker:v1:refresh-001\n"
        ),
        file(
          "index.html",
          "<main>Refresh target</main>\n<!-- pcms-refresh-marker:v1:refresh-001 -->\n"
        )
      ],
      isPublic: true
    });
    assert.deepEqual(saved, {
      status: "saved",
      publicId: "public-refresh-target"
    });

    const effectPending = emulator.readRefreshEffect(
      "public-refresh-target"
    );
    assert.deepEqual(effectPending, {
      contractVersion: 1,
      semantic: "REFRESH_EFFECT",
      state: "PENDING",
      publicId: "public-refresh-target",
      markerStrategyId: "PCMS_MARKER_BOTH_V1",
      refreshToken: "refresh-001",
      refreshSequence: 1,
      recentRank: null
    });

    const recentStillUnchanged = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/recent"
    );
    assert.deepEqual(
      recentStillUnchanged.items.map((item) => item.publicId),
      ["public-recent-existing"]
    );

    emulator.publishRefreshEffect("public-refresh-target");

    const effectVisible = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/refresh-effect?publicId=public-refresh-target"
    );
    assert.deepEqual(effectVisible, {
      contractVersion: 1,
      semantic: "REFRESH_EFFECT",
      state: "VISIBLE",
      publicId: "public-refresh-target",
      markerStrategyId: "PCMS_MARKER_BOTH_V1",
      refreshToken: "refresh-001",
      refreshSequence: 1,
      recentRank: 0
    });

    const recentAfter = await getJson(
      emulator.origin,
      "/__pcms_emulator__/observations/recent"
    );
    assert.deepEqual(
      recentAfter.items.map((item) => item.publicId),
      ["public-refresh-target", "public-recent-existing"]
    );
    assert.equal(recentAfter.observedSlotCount, 2);

    const requests = emulator.requests();
    assert.equal(
      JSON.stringify(requests).includes("fixture-session-p034"),
      false
    );
  } finally {
    await emulator.close();
  }
});
