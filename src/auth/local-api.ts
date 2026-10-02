import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class LocalApiAuthError extends Error {
  public readonly code = "LOCAL_API_AUTH_FAILED";

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalApiAuthError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function validateToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new LocalApiAuthError("Local API token file contains invalid data");
  }
  return token;
}

export async function ensureLocalApiToken(path: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  let handle = null;

  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    return token;
  } catch (error: unknown) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    if (errorCode(error) !== "EEXIST") {
      throw new LocalApiAuthError(
        `Failed to create local API token at ${path}`,
        error
      );
    }
  }

  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new LocalApiAuthError(
        "Local API token path must be a regular file"
      );
    }

    await chmod(path, 0o600);
    const existing = (await readFile(path, "utf8")).trim();
    return validateToken(existing);
  } catch (error: unknown) {
    if (error instanceof LocalApiAuthError) {
      throw error;
    }
    throw new LocalApiAuthError(
      `Failed to read local API token at ${path}`,
      error
    );
  }
}

export function localApiTokenMatches(
  expectedToken: string,
  candidateToken: string
): boolean {
  const expected = Buffer.from(expectedToken, "utf8");
  const candidate = Buffer.from(candidateToken, "utf8");
  return (
    expected.byteLength === candidate.byteLength &&
    timingSafeEqual(expected, candidate)
  );
}

export function bearerToken(
  authorizationHeader: string | undefined
): string | null {
  if (authorizationHeader === undefined) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorizationHeader);
  return match?.[1] ?? null;
}
