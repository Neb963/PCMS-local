import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const bundleRoot = join(
  process.cwd(),
  "build",
  "pcms-local-dev"
);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: "127.0.0.1", port: 0 },
      resolve
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) =>
      error ? reject(error) : resolve()
    );
  });
  return port;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function filesBelow(root, directory = root) {
  const output = [];
  for (
    const entry of await readdir(
      directory,
      { withFileTypes: true }
    )
  ) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await filesBelow(root, path));
    } else if (entry.isFile()) {
      output.push(relative(root, path));
    }
  }
  return output;
}

async function makeUpdateBundle(root) {
  await cp(bundleRoot, root, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8")
  );
  manifest.packageVersion = "0.0.1-test";
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n"
  );

  const files = (
    await filesBelow(root)
  )
    .filter((path) => path !== "SHA256SUMS")
    .sort();
  const lines = [];
  for (const path of files) {
    lines.push(
      (await hashFile(join(root, path))) +
        "  " +
        path
    );
  }
  await writeFile(
    join(root, "SHA256SUMS"),
    lines.join("\n") + "\n"
  );
}

async function writeFakeCommands(binDir) {
  await mkdir(binDir, { recursive: true });
  const systemctl = [
    "#!/bin/sh",
    "set -eu",
    "printf '%s\\n' \"$*\" >> \"$PCMS_FAKE_SYSTEMCTL_LOG\"",
    "start_daemon() {",
    "  if [ -f \"$PCMS_FAKE_SYSTEMCTL_PID\" ]; then",
    "    pid=$(cat \"$PCMS_FAKE_SYSTEMCTL_PID\")",
    "    if kill -0 \"$pid\" 2>/dev/null; then",
    "      return",
    "    fi",
    "    rm -f \"$PCMS_FAKE_SYSTEMCTL_PID\"",
    "  fi",
    "  nohup \"$HOME/.local/lib/pcms-local/current/bin/pcmsd\" >>\"$PCMS_FAKE_DAEMON_LOG\" 2>&1 &",
    "  echo $! > \"$PCMS_FAKE_SYSTEMCTL_PID\"",
    "}",
    "stop_daemon() {",
    "  if [ ! -f \"$PCMS_FAKE_SYSTEMCTL_PID\" ]; then",
    "    return",
    "  fi",
    "  pid=$(cat \"$PCMS_FAKE_SYSTEMCTL_PID\")",
    "  kill \"$pid\" 2>/dev/null || true",
    "  i=0",
    "  while kill -0 \"$pid\" 2>/dev/null && [ \"$i\" -lt 100 ]; do",
    "    sleep 0.05",
    "    i=$((i + 1))",
    "  done",
    "  rm -f \"$PCMS_FAKE_SYSTEMCTL_PID\"",
    "}",
    "case \"$*\" in",
    "  \"--user restart pcmsd.service\")",
    "    stop_daemon",
    "    start_daemon",
    "    ;;",
    "  \"--user start pcmsd.service\")",
    "    start_daemon",
    "    ;;",
    "  \"--user stop pcmsd.service\")",
    "    stop_daemon",
    "    ;;",
    "esac",
    "exit 0",
    ""
  ].join("\n");
  const xdgOpen = [
    "#!/bin/sh",
    "set -eu",
    "printf '%s\\n' \"$1\" >> \"$PCMS_FAKE_XDG_LOG\"",
    ""
  ].join("\n");
  const rejectPackageManager = [
    "#!/bin/sh",
    "echo \"package manager must not be used by installed PCMS\" >&2",
    "exit 97",
    ""
  ].join("\n");

  for (const [name, body] of [
    ["systemctl", systemctl],
    ["xdg-open", xdgOpen],
    ["npm", rejectPackageManager],
    ["pnpm", rejectPackageManager],
    ["yarn", rejectPackageManager]
  ]) {
    const path = join(binDir, name);
    await writeFile(path, body, { mode: 0o755 });
  }
}

async function missing(path) {
  await assert.rejects(
    () => access(path),
    (error) => error?.code === "ENOENT"
  );
}

async function stopFakeDaemon(env) {
  try {
    await execFileAsync(
      join(env.PCMS_FAKE_BIN, "systemctl"),
      ["--user", "stop", "pcmsd.service"],
      { env }
    );
  } catch {
    // Final cleanup is best-effort only.
  }
}

test("P044 clean user install, update, desktop launch and uninstall preserve data unless purge is explicit", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p044-install-")
  );
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const updateBundle = join(root, "update-bundle");
  await mkdir(home, { recursive: true });
  await writeFakeCommands(fakeBin);
  await makeUpdateBundle(updateBundle);

  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    PCMS_PORT: String(port),
    PCMS_FAKE_BIN: fakeBin,
    PCMS_FAKE_SYSTEMCTL_LOG: join(
      root,
      "systemctl.log"
    ),
    PCMS_FAKE_SYSTEMCTL_PID: join(
      root,
      "pcmsd.pid"
    ),
    PCMS_FAKE_DAEMON_LOG: join(
      root,
      "pcmsd.log"
    ),
    PCMS_FAKE_XDG_LOG: join(root, "xdg.log"),
    PATH: [
      fakeBin,
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ].join(":")
  };

  const installRoot = join(
    home,
    ".local",
    "lib",
    "pcms-local"
  );
  const current = join(installRoot, "current");
  const cli = join(home, ".local", "bin", "pcms");
  const opener = join(
    home,
    ".local",
    "bin",
    "pcms-open"
  );
  const uninstaller = join(
    home,
    ".local",
    "bin",
    "pcms-uninstall"
  );
  const service = join(
    home,
    ".config",
    "systemd",
    "user",
    "pcmsd.service"
  );
  const desktop = join(
    home,
    ".local",
    "share",
    "applications",
    "pcms-local.desktop"
  );
  const dataRoot = join(
    home,
    ".local",
    "share",
    "pcms-local"
  );
  const configRoot = join(
    home,
    ".config",
    "pcms-local"
  );
  const cacheRoot = join(
    home,
    ".cache",
    "pcms-local"
  );

  try {
    const installed = await execFileAsync(
      join(bundleRoot, "install.sh"),
      [],
      { env, cwd: bundleRoot }
    );
    assert.equal(installed.stderr, "");
    assert.match(
      installed.stdout,
      /Installed PCMS Local/
    );

    const initialTarget = await readlink(current);
    assert.match(initialTarget, /^releases\//);
    assert.equal((await stat(cli)).isFile(), true);
    assert.match(
      await readFile(service, "utf8"),
      /^# Managed by PCMS Local installer$/m
    );
    const desktopText = await readFile(
      desktop,
      "utf8"
    );
    assert.match(
      desktopText,
      /^Exec=".*\/pcms-open"$/m
    );
    assert.equal(
      desktopText.includes("api-token"),
      false
    );

    const status = await execFileAsync(
      cli,
      ["status", "--json"],
      { env }
    );
    assert.equal(status.stderr, "");
    assert.equal(
      JSON.parse(status.stdout).ok,
      true
    );

    await execFileAsync(opener, [], { env });
    const opened = (
      await readFile(env.PCMS_FAKE_XDG_LOG, "utf8")
    ).trim();
    assert.equal(
      opened,
      "http://127.0.0.1:" + String(port)
    );

    await mkdir(dataRoot, { recursive: true });
    await mkdir(configRoot, { recursive: true });
    await mkdir(cacheRoot, { recursive: true });
    const dataSentinel = join(
      dataRoot,
      "operator-state.txt"
    );
    const configSentinel = join(
      configRoot,
      "operator-config.txt"
    );
    const cacheSentinel = join(
      cacheRoot,
      "operator-cache.txt"
    );
    await writeFile(dataSentinel, "keep-data");
    await writeFile(configSentinel, "keep-config");
    await writeFile(cacheSentinel, "keep-cache");

    const updated = await execFileAsync(
      join(updateBundle, "install.sh"),
      [],
      { env, cwd: updateBundle }
    );
    assert.equal(updated.stderr, "");
    const updatedTarget = await readlink(current);
    assert.notEqual(updatedTarget, initialTarget);
    await access(
      join(installRoot, initialTarget)
    );
    assert.equal(
      await readFile(dataSentinel, "utf8"),
      "keep-data"
    );
    assert.equal(
      await readFile(configSentinel, "utf8"),
      "keep-config"
    );

    const removed = await execFileAsync(
      uninstaller,
      [],
      { env }
    );
    assert.equal(removed.stderr, "");
    assert.match(
      removed.stdout,
      /User data, Persona profiles and router configuration were preserved/
    );
    await missing(installRoot);
    await missing(cli);
    await missing(opener);
    await missing(uninstaller);
    await missing(service);
    await missing(desktop);
    assert.equal(
      await readFile(dataSentinel, "utf8"),
      "keep-data"
    );
    assert.equal(
      await readFile(configSentinel, "utf8"),
      "keep-config"
    );
    assert.equal(
      await readFile(cacheSentinel, "utf8"),
      "keep-cache"
    );

    await execFileAsync(
      join(updateBundle, "install.sh"),
      [],
      { env, cwd: updateBundle }
    );
    const profileSentinel = join(
      dataRoot,
      "personas",
      "persona-p044",
      "chromium",
      "Cookies"
    );
    await mkdir(
      join(profileSentinel, ".."),
      { recursive: true }
    );
    await writeFile(
      profileSentinel,
      "profile-must-not-delete-without-confirmation"
    );

    await assert.rejects(
      () =>
        execFileAsync(
          uninstaller,
          ["--purge-data"],
          { env }
        ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /both --purge-data and --yes/
        );
        return true;
      }
    );
    assert.equal(
      await readFile(profileSentinel, "utf8"),
      "profile-must-not-delete-without-confirmation"
    );

    const purged = await execFileAsync(
      uninstaller,
      ["--purge-data", "--yes"],
      { env }
    );
    assert.equal(purged.stderr, "");
    assert.match(
      purged.stdout,
      /Privileged router configuration was not modified/
    );
    await missing(dataRoot);
    await missing(configRoot);
    await missing(cacheRoot);

    const systemctlLog = await readFile(
      env.PCMS_FAKE_SYSTEMCTL_LOG,
      "utf8"
    );
    assert.match(
      systemctlLog,
      /--user enable pcmsd\.service/
    );
    assert.match(
      systemctlLog,
      /--user restart pcmsd\.service/
    );
    assert.match(
      systemctlLog,
      /--user stop pcmsd\.service/
    );
  } finally {
    await stopFakeDaemon(env);
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});
