import { resolvePcmsdPort } from "../config/daemon.js";
import { resolvePcmsPaths } from "../config/paths.js";
import { startPcmsd, type PcmsdHandle } from "./server.js";

function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return {
      code: typeof code === "string" ? code : "PCMSD_START_FAILED",
      message: error.message
    };
  }
  return {
    code: "PCMSD_START_FAILED",
    message: "Unknown startup failure"
  };
}

async function run(): Promise<void> {
  let daemon: PcmsdHandle | null = null;

  try {
    daemon = await startPcmsd({
      paths: resolvePcmsPaths(),
      port: resolvePcmsdPort()
    });
  } catch (error: unknown) {
    process.stderr.write(
      `${JSON.stringify({ event: "pcmsd.start_failed", error: errorDetails(error) })}\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "pcmsd.started",
      host: daemon.host,
      port: daemon.port,
      origin: daemon.origin,
      startedAt: daemon.startedAt
    })}\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shuttingDown || daemon === null) {
      return;
    }
    shuttingDown = true;

    try {
      await daemon.close();
      process.stdout.write(
        `${JSON.stringify({ event: "pcmsd.stopped", signal })}\n`
      );
    } catch (error: unknown) {
      process.stderr.write(
        `${JSON.stringify({ event: "pcmsd.stop_failed", error: errorDetails(error) })}\n`
      );
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

await run();
