import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_INCOMPLETE_LOCK_GRACE_MS = 2_000;

export interface InstanceOwner {
  readonly pid: number;
  readonly processStartTicks: string | null;
  readonly token: string;
  readonly acquiredAt: string;
}

export interface ProcessIdentityProbe {
  readStartTicks(pid: number): Promise<string | null>;
  isProcessAlive(pid: number): boolean;
}

export interface AcquireInstanceLockOptions {
  readonly probe?: ProcessIdentityProbe;
  readonly now?: () => Date;
  readonly incompleteLockGraceMs?: number;
}

export interface InstanceLock {
  readonly path: string;
  readonly owner: InstanceOwner;
  release(): Promise<void>;
}

export class InstanceAlreadyRunningError extends Error {
  public readonly code = "INSTANCE_ALREADY_RUNNING";
  public readonly owner: InstanceOwner;

  public constructor(owner: InstanceOwner) {
    super(`pcmsd is already running as pid ${owner.pid}`);
    this.name = "InstanceAlreadyRunningError";
    this.owner = owner;
  }
}

export class InstanceLockUncertainError extends Error {
  public readonly code = "INSTANCE_LOCK_UNCERTAIN";

  public constructor(message: string) {
    super(message);
    this.name = "InstanceLockUncertainError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function readLinuxProcessStartTicks(pid: number): Promise<string | null> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = contents.lastIndexOf(")");
    if (commandEnd < 0) {
      return null;
    }

    const fieldsAfterCommand = contents.slice(commandEnd + 1).trim().split(/\s+/u);
    return fieldsAfterCommand[19] ?? null;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    return null;
  }
}

export const defaultProcessIdentityProbe: ProcessIdentityProbe = Object.freeze({
  readStartTicks: readLinuxProcessStartTicks,
  isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === "EPERM") {
        return true;
      }
      if (code === "ESRCH") {
        return false;
      }
      return false;
    }
  }
});

function parseOwner(raw: string): InstanceOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<InstanceOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      (value.processStartTicks !== null && typeof value.processStartTicks !== "string") ||
      typeof value.token !== "string" ||
      value.token.length < 16 ||
      typeof value.acquiredAt !== "string" ||
      Number.isNaN(Date.parse(value.acquiredAt))
    ) {
      return null;
    }

    return Object.freeze({
      pid: value.pid as number,
      processStartTicks: value.processStartTicks,
      token: value.token,
      acquiredAt: value.acquiredAt
    });
  } catch {
    return null;
  }
}

async function ownerIsLive(owner: InstanceOwner, probe: ProcessIdentityProbe): Promise<boolean> {
  const observedStartTicks = await probe.readStartTicks(owner.pid);
  if (owner.processStartTicks !== null && observedStartTicks !== null) {
    return owner.processStartTicks === observedStartTicks;
  }
  return probe.isProcessAlive(owner.pid);
}

async function removeIfUnchanged(path: string, expectedRaw: string): Promise<boolean> {
  try {
    const currentRaw = await readFile(path, "utf8");
    if (currentRaw !== expectedRaw) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function inspectExistingLock(
  path: string,
  probe: ProcessIdentityProbe,
  now: Date,
  incompleteLockGraceMs: number
): Promise<"removed" | "retry"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "retry";
    }
    throw error;
  }

  const owner = parseOwner(raw);
  if (owner !== null) {
    if (await ownerIsLive(owner, probe)) {
      throw new InstanceAlreadyRunningError(owner);
    }
    return (await removeIfUnchanged(path, raw)) ? "removed" : "retry";
  }

  const info = await stat(path);
  if (now.getTime() - info.mtimeMs < incompleteLockGraceMs) {
    throw new InstanceLockUncertainError(
      "pcmsd instance lock exists but has no complete owner record; refusing to steal a fresh lock"
    );
  }

  return (await removeIfUnchanged(path, raw)) ? "removed" : "retry";
}

export async function acquireInstanceLock(
  path: string,
  options: AcquireInstanceLockOptions = {}
): Promise<InstanceLock> {
  const probe = options.probe ?? defaultProcessIdentityProbe;
  const now = options.now ?? (() => new Date());
  const incompleteLockGraceMs =
    options.incompleteLockGraceMs ?? DEFAULT_INCOMPLETE_LOCK_GRACE_MS;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const owner: InstanceOwner = Object.freeze({
    pid: process.pid,
    processStartTicks: await probe.readStartTicks(process.pid),
    token: randomUUID(),
    acquiredAt: now().toISOString()
  });
  const serializedOwner = `${JSON.stringify(owner)}\n`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(serializedOwner, "utf8");
        await handle.sync();
      } catch (error: unknown) {
        await handle.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await handle.close();

      let released = false;
      return Object.freeze({
        path,
        owner,
        async release(): Promise<void> {
          if (released) {
            return;
          }
          released = true;

          try {
            const raw = await readFile(path, "utf8");
            const current = parseOwner(raw);
            if (current?.token === owner.token) {
              await unlink(path);
            }
          } catch (error: unknown) {
            if (errorCode(error) !== "ENOENT") {
              throw error;
            }
          }
        }
      });
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      const state = await inspectExistingLock(
        path,
        probe,
        now(),
        incompleteLockGraceMs
      );
      if (state === "removed" || state === "retry") {
        continue;
      }
    }
  }

  throw new InstanceLockUncertainError(
    "pcmsd instance lock changed repeatedly during acquisition"
  );
}
