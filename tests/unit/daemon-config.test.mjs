import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PCMSD_PORT,
  PCMSD_LOOPBACK_HOST,
  resolvePcmsdPort
} from "../../dist/config/daemon.js";
import { ConfigurationError } from "../../dist/config/paths.js";

test("pcmsd defaults to a fixed IPv4 loopback endpoint", () => {
  assert.equal(PCMSD_LOOPBACK_HOST, "127.0.0.1");
  assert.equal(resolvePcmsdPort({}), DEFAULT_PCMSD_PORT);
});

test("PCMS_PORT accepts only valid unprivileged TCP port values", () => {
  assert.equal(resolvePcmsdPort({ PCMS_PORT: "43210" }), 43_210);

  for (const value of ["0", "65536", "-1", "12.5", "abc"]) {
    assert.throws(
      () => resolvePcmsdPort({ PCMS_PORT: value }),
      ConfigurationError
    );
  }
});
