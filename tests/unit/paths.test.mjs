import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigurationError,
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";

test("resolves standard XDG defaults under the user home", () => {
  const paths = resolvePcmsPaths({ env: {}, homeDir: "/home/tester" });

  assert.equal(paths.configRoot, "/home/tester/.config/pcms-local");
  assert.equal(paths.dataRoot, "/home/tester/.local/share/pcms-local");
  assert.equal(paths.cacheRoot, "/home/tester/.cache/pcms-local");
  assert.equal(paths.runtimeRoot, "/home/tester/.local/share/pcms-local/runtime");
  assert.equal(paths.personasRoot, "/home/tester/.local/share/pcms-local/personas");
  assert.equal(paths.databasePath, "/home/tester/.local/share/pcms-local/pcms.db");
  assert.equal(paths.apiTokenFile, "/home/tester/.config/pcms-local/api-token");
});

test("honors absolute XDG roots and ignores invalid relative XDG values", () => {
  const absolute = resolvePcmsPaths({
    env: {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache"
    },
    homeDir: "/home/tester"
  });
  assert.equal(absolute.configRoot, "/xdg/config/pcms-local");
  assert.equal(absolute.dataRoot, "/xdg/data/pcms-local");
  assert.equal(absolute.cacheRoot, "/xdg/cache/pcms-local");

  const relative = resolvePcmsPaths({
    env: {
      XDG_CONFIG_HOME: "relative/config",
      XDG_DATA_HOME: "relative/data",
      XDG_CACHE_HOME: "relative/cache"
    },
    homeDir: "/home/tester"
  });
  assert.equal(relative.configRoot, "/home/tester/.config/pcms-local");
  assert.equal(relative.dataRoot, "/home/tester/.local/share/pcms-local");
  assert.equal(relative.cacheRoot, "/home/tester/.cache/pcms-local");
});

test("explicit PCMS roots are absolute, normalized and bounded away from filesystem root", () => {
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: "/srv/operator/../pcms-config",
      PCMS_DATA_ROOT: "/srv/pcms-data",
      PCMS_CACHE_ROOT: "/srv/pcms-cache"
    },
    homeDir: "/home/tester"
  });

  assert.equal(paths.configRoot, "/srv/pcms-config");
  assert.equal(paths.dataRoot, "/srv/pcms-data");
  assert.equal(paths.cacheRoot, "/srv/pcms-cache");

  for (const value of ["relative", "/"]) {
    assert.throws(
      () => resolvePcmsPaths({ env: { PCMS_DATA_ROOT: value }, homeDir: "/home/tester" }),
      ConfigurationError
    );
  }
});

test("creates private configuration, data, cache and runtime directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-paths-"));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });

  await ensurePcmsDirectories(paths);

  for (const path of [
    paths.configRoot,
    paths.dataRoot,
    paths.cacheRoot,
    paths.runtimeRoot,
    paths.personasRoot
  ]) {
    const info = await stat(path);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.mode & 0o777, 0o700);
  }
});
