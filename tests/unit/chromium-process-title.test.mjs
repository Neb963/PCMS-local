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
import { waitForFingerprintGone } from "../../dist/personas/chromium-browser.js";

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

test("transient argv state during the process-title rewrite recovers via bounded re-reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-title-transient-"));
  let child;
  try {
    await withProfile(root, async (profile) => {
      const finalTitle = [
        "fake-chromium",
        `--user-data-dir=${profile}`,
        "--headless=new",
        "about:blank"
      ].join(" ");
      // Start with a title that does not yet identify the profile, then
      // finish the rewrite shortly afterwards: a capture racing the rewrite
      // must re-read rather than fail the launch.
      const transientScript = [
        "process.title = 'fake-chromium starting';",
        `setTimeout(() => { process.title = ${JSON.stringify(finalTitle)}; }, 120);`,
        "setInterval(() => {}, 1000);"
      ].join(" ");
      child = startFakeChromium(["-e", transientScript]);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        process.execPath,
        profile
      );
      assert.equal(
        await inspectChromiumProcessOwnership(fingerprint),
        "OWNED",
        "capture must tolerate a mid-rewrite argv read by re-reading evidence"
      );
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

test("waitForFingerprintGone tolerates a transient teardown mismatch and observes exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-fingerprint-transient-"));
  let child;
  try {
    await withProfile(root, async (profile) => {
      const goodTitle = [
        "fake-chromium",
        `--user-data-dir=${profile}`,
        "--headless=new",
        "about:blank"
      ].join(" ");
      // Live with matching evidence, then churn the title the way a dying
      // Chromium does, then exit: the wait must ride out the mismatch.
      const script = [
        `process.title = ${JSON.stringify(goodTitle)};`,
        "setTimeout(() => { process.title = 'fake-chromium shutting down'; }, 700);",
        "setTimeout(() => { process.exit(0); }, 1200);",
        "setInterval(() => {}, 1000);"
      ].join(" ");
      child = startFakeChromium(["-e", script]);
      await new Promise((resolve) => setTimeout(resolve, 400));

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        process.execPath,
        profile
      );

      const startedAt = Date.now();
      const gone = await waitForFingerprintGone(fingerprint, 5_000);
      const elapsed = Date.now() - startedAt;
      assert.equal(gone, true, "the process exit must be observed as GONE");
      assert.ok(
        elapsed < 4_500,
        `exit must be observed without consuming the whole timeout (took ${elapsed}ms)`
      );
    });
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("waitForFingerprintGone fails closed on a persistent mismatch without signalling the pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-fingerprint-persist-"));
  let child;
  try {
    await withProfile(root, async (profile) => {
      const goodTitle = [
        "fake-chromium",
        `--user-data-dir=${profile}`,
        "--headless=new",
        "about:blank"
      ].join(" ");
      // Matching evidence only briefly, then a permanently different title:
      // ambiguous ownership must end in a fail-closed error, and the pid
      // must not be signalled while evidence is ambiguous.
      const script = [
        `process.title = ${JSON.stringify(goodTitle)};`,
        "setTimeout(() => { process.title = 'something-else'; }, 700);",
        "setInterval(() => {}, 1000);"
      ].join(" ");
      child = startFakeChromium(["-e", script]);
      await new Promise((resolve) => setTimeout(resolve, 400));

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        process.execPath,
        profile
      );

      await assert.rejects(
        waitForFingerprintGone(fingerprint, 2_600),
        (error) => {
          assert.equal(error.code, "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS");
          return true;
        }
      );
      assert.doesNotThrow(
        () => process.kill(child.pid, 0),
        "an ambiguous pid must not be signalled during the wait"
      );
    });
  } finally {
    if (child !== undefined) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});
