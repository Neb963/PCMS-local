import assert from "node:assert/strict";
import test from "node:test";

import {
  PCMSD_USER_SERVICE,
  PCMSD_USER_SERVICE_INSTALL_PATH
} from "../../dist/install/systemd.js";

test("user-systemd service launches the installed bundle with bounded restart policy", () => {
  assert.equal(
    PCMSD_USER_SERVICE_INSTALL_PATH,
    "~/.config/systemd/user/pcmsd.service"
  );
  assert.match(
    PCMSD_USER_SERVICE,
    /^ExecStart=%h\/.local\/lib\/pcms-local\/current\/bin\/pcmsd$/m
  );
  assert.match(PCMSD_USER_SERVICE, /^Type=simple$/m);
  assert.match(PCMSD_USER_SERVICE, /^UMask=0077$/m);
  assert.match(PCMSD_USER_SERVICE, /^Restart=on-failure$/m);
  assert.match(PCMSD_USER_SERVICE, /^RestartSec=2s$/m);
  assert.match(PCMSD_USER_SERVICE, /^StartLimitBurst=5$/m);
  assert.match(PCMSD_USER_SERVICE, /^KillSignal=SIGTERM$/m);
  assert.match(PCMSD_USER_SERVICE, /^TimeoutStopSec=15s$/m);
  assert.match(PCMSD_USER_SERVICE, /^NoNewPrivileges=yes$/m);
  assert.match(
    PCMSD_USER_SERVICE,
    /^EnvironmentFile=-%h\/.config\/pcms-local\/pcmsd\.env$/m
  );
});
