import assert from "node:assert/strict";
import test from "node:test";

import {
  PCMS_INSTALL_MARKER,
  renderPcmsDesktopEntry,
  resolvePcmsInstallPaths
} from "../../dist/install/layout.js";

test("P044 install layout stays inside the current user home", () => {
  const paths = resolvePcmsInstallPaths("/home/pcms-user");

  assert.equal(
    paths.installRoot,
    "/home/pcms-user/.local/lib/pcms-local"
  );
  assert.equal(
    paths.currentLink,
    "/home/pcms-user/.local/lib/pcms-local/current"
  );
  assert.equal(
    paths.cliLink,
    "/home/pcms-user/.local/bin/pcms"
  );
  assert.equal(
    paths.uninstallLink,
    "/home/pcms-user/.local/bin/pcms-uninstall"
  );
  assert.equal(
    paths.servicePath,
    "/home/pcms-user/.config/systemd/user/pcmsd.service"
  );
  assert.equal(
    paths.desktopPath,
    "/home/pcms-user/.local/share/applications/pcms-local.desktop"
  );
});

test("P044 desktop entry launches the managed PCMS opener without a token URL", () => {
  const entry = renderPcmsDesktopEntry(
    "/home/pcms user/.local/lib/pcms-local/current/bin/pcms-open"
  );

  assert.ok(entry.startsWith(PCMS_INSTALL_MARKER + "\n"));
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=PCMS Local$/m);
  assert.match(
    entry,
    /^Exec="\/home\/pcms user\/\.local\/lib\/pcms-local\/current\/bin\/pcms-open"$/m
  );
  assert.match(entry, /^Terminal=false$/m);
  assert.equal(entry.includes("api-token"), false);
  assert.equal(entry.includes("Bearer"), false);
});
