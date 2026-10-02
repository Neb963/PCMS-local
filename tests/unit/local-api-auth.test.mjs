import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalApiAuthError,
  bearerToken,
  ensureLocalApiToken,
  localApiTokenMatches
} from "../../dist/auth/local-api.js";

test("creates and reuses a private high-entropy local API token", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-auth-"));
  const path = join(root, "api-token");

  try {
    const first = await ensureLocalApiToken(path);
    const second = await ensureLocalApiToken(path);

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(second, first);
    assert.equal((await readFile(path, "utf8")).trim(), first);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal(localApiTokenMatches(first, second), true);
    assert.equal(localApiTokenMatches(first, "x".repeat(43)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed existing token data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-auth-invalid-"));
  const path = join(root, "api-token");
  await writeFile(path, "not-a-valid-token\n", { mode: 0o600 });

  try {
    await assert.rejects(
      () => ensureLocalApiToken(path),
      LocalApiAuthError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses only the exact local bearer token shape", () => {
  const token = "a".repeat(43);
  assert.equal(bearerToken(`Bearer ${token}`), token);
  assert.equal(bearerToken(`bearer ${token}`), null);
  assert.equal(bearerToken("Bearer short"), null);
  assert.equal(bearerToken(undefined), null);
});
