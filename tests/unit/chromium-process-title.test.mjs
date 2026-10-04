import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import {
  captureChromiumProcessFingerprint,
  inspectChromiumProcessOwnership
} from "../../dist/personas/chromium-runtime.js";

function startFakeChromium(argv) {
  return spawn(process.execPath, argv, { stdio: "ignore" });
}

function keepaliveScript(rewriteTitle) {
  const title = rewriteTitle === null
    ? ""
    : `process.title = ${JSON.stringify(rewriteTitle)}; `;
  return `${title}setInterval(() => {}, 1000);`;
}

async function withProfile(root, run) {
  const profile = join(root, `profile-${Math.random().toString(36).slice(2)}`);
  await mkdir(profile, { recursive: true });
  return run(profile);
}

test("Chromium process-title cmdline rewrite keeps the owned Persona recognizable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-title-rewrite-"));
  let child;
  try {
    const result = await withProfile(root, async (profile) => {
      // Modern Chromium rewrites /proc/<pid>/cmdline into a single
      // space-joined entry shortly after startup (observed live on Chrome for
      // Testing 154 on Linux kernels that permit the PR_SET_MM rewrite).
      const title = [
        "fake-chromium",
        `--user-data-dir=${profile}`,
        "--remote-debugging-address=127.0.0.1",
        "--headless=new",
        "about:blank"
      ].join(" ");
      child = startFakeChromium(["-e", keepaliveScript(title)]);
      await new Promise((resolve) => setTimeout(resolve, 700));

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        process.execPath,
        profile
      );
      assert.equal(
        await inspectChromiumProcessOwnership(fingerprint),
        "OWNED",
        "rewritten single-entry cmdline must still verify as the owned Persona process"
      );
      return fingerprint;
    });
    assert.ok(Number.isSafeInteger(result.pid));
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("NUL-separated Chromium cmdline keeps verifying as the owned Persona process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-title-nul-"));
  let child;
  try {
    await withProfile(root, async (profile) => {
      child = startFakeChromium([
        "-e",
        keepaliveScript(null),
        "--",
        `--user-data-dir=${profile}`
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        process.execPath,
        profile
      );
      assert.equal(await inspectChromiumProcessOwnership(fingerprint), "OWNED");
    });
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("prefixed sibling profile path must not satisfy the ownership check", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-title-boundary-"));
  let child;
  try {
    await withProfile(root, async (profile) => {
      const impostorTitle = [
        "fake-chromium",
        `--user-data-dir=${profile}-extra`,
        "--headless=new",
        "about:blank"
      ].join(" ");
      child = startFakeChromium(["-e", keepaliveScript(impostorTitle)]);
      await new Promise((resolve) => setTimeout(resolve, 700));

      await assert.rejects(
        captureChromiumProcessFingerprint(child.pid, process.execPath, profile),
        /ownership evidence/u,
        "a longer sibling path containing the profile path as a prefix must not match"
      );
    });
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});
