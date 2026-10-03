import assert from "node:assert/strict";
import test from "node:test";

import {
  observeSyntheticSocksEgress,
  startSyntheticSocksExit
} from "./synthetic-protected-egress-fixture.mjs";

test("synthetic SOCKS exits expose distinguishable observed identities", async () => {
  const alpha = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-alpha"
  });
  const beta = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-beta"
  });

  try {
    assert.notEqual(alpha.port, beta.port);

    const alphaObserved = await observeSyntheticSocksEgress({
      proxyHost: alpha.host,
      proxyPort: alpha.port
    });
    const betaObserved = await observeSyntheticSocksEgress({
      proxyHost: beta.host,
      proxyPort: beta.port
    });

    assert.equal(alphaObserved.routeIdentity, "synthetic-exit-alpha");
    assert.equal(betaObserved.routeIdentity, "synthetic-exit-beta");
    assert.equal(alphaObserved.requestedHost, "pcms-egress.invalid");
    assert.equal(betaObserved.requestedHost, "pcms-egress.invalid");
    assert.equal(alpha.observations.length, 1);
    assert.equal(beta.observations.length, 1);
  } finally {
    await Promise.all([alpha.close(), beta.close()]);
  }
});
