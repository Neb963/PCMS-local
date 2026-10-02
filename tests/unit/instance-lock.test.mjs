import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceAlreadyRunningError,
  InstanceLockUncertainError,
  acquireInstanceLock
} from "../../dist/runtime/instance-lock.js";

test("exclusive instance ownership rejects a second live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-lock-live-"));
  const path = join(root, "pcmsd.lock");
  const first = await acquireInstanceLock(path);

  try {
    await assert.rejects(() => acquireInstanceLock(path), InstanceAlreadyRunningError);
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await first.release();
  }

  await assert.rejects(() => readFile(path, "utf8"), { code: "ENOENT" });
});

test("stale owner record is reclaimed before acquiring ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-lock-stale-"));
  const path = join(root, "pcmsd.lock");
  const staleOwner = {
    pid: 999_999_999,
    processStartTicks: null,
    token: "stale-owner-token-0001",
    acquiredAt: "2026-01-01T00:00:00.000Z"
  };
  await writeFile(path, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });

  const lock = await acquireInstanceLock(path);
  try {
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, staleOwner.token);
  } finally {
    await lock.release();
  }
});

test("process identity mismatch treats a reused pid as stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-lock-reuse-"));
  const path = join(root, "pcmsd.lock");
  const reusedPidOwner = {
    pid: process.pid,
    processStartTicks: "old-start-ticks",
    token: "reused-pid-token-0001",
    acquiredAt: "2026-01-01T00:00:00.000Z"
  };
  await writeFile(path, `${JSON.stringify(reusedPidOwner)}\n`, { mode: 0o600 });

  const probe = {
    async readStartTicks() {
      return "new-start-ticks";
    },
    isProcessAlive() {
      return true;
    }
  };

  const lock = await acquireInstanceLock(path, { probe });
  await lock.release();
});

test("fresh incomplete lock is not stolen", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-lock-incomplete-"));
  const path = join(root, "pcmsd.lock");
  await writeFile(path, "", { mode: 0o600 });

  await assert.rejects(
    () => acquireInstanceLock(path, { incompleteLockGraceMs: 60_000 }),
    InstanceLockUncertainError
  );
});

test("old incomplete lock can be reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-lock-old-incomplete-"));
  const path = join(root, "pcmsd.lock");
  await writeFile(path, "partial", { mode: 0o600 });
  const old = new Date("2026-01-01T00:00:00.000Z");
  await utimes(path, old, old);

  const lock = await acquireInstanceLock(path, {
    now: () => new Date("2026-01-01T00:00:10.000Z"),
    incompleteLockGraceMs: 1_000
  });
  await lock.release();
});
