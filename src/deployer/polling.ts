import {
  ProviderGateError,
  type ProviderGate,
  type ProviderGateScope
} from "../operations/provider-gate.js";
import type {
  DurableScheduler,
  ScheduleDispatchIntent,
  ScheduleRecord
} from "../scheduler/durable-scheduler.js";

export interface DeployerPollExecutionInput {
  readonly intent: ScheduleDispatchIntent;
  readonly scope: ProviderGateScope;
  readonly poll: (
    intent: ScheduleDispatchIntent
  ) => void | Promise<void>;
}

export type DeployerPollExecutionResult =
  | Readonly<{
      status: "COMPLETED";
      schedule: ScheduleRecord;
    }>
  | Readonly<{
      status: "BACKPRESSURED";
      retryAt: string | null;
      reason: "PROVIDER_BUSY" | "PROVIDER_COOLDOWN";
    }>;

export class DeployerPollExecutor {
  readonly #scheduler: DurableScheduler;
  readonly #providerGate: ProviderGate;

  public constructor(options: Readonly<{
    scheduler: DurableScheduler;
    providerGate: ProviderGate;
  }>) {
    this.#scheduler = options.scheduler;
    this.#providerGate = options.providerGate;
  }

  public async execute(
    input: DeployerPollExecutionInput
  ): Promise<DeployerPollExecutionResult> {
    let permit;
    try {
      permit = this.#providerGate.acquire(input.scope);
    } catch (error: unknown) {
      this.#scheduler.abandonClaim(
        input.intent.scheduleId,
        input.intent.dispatchId
      );
      if (
        error instanceof ProviderGateError &&
        (
          error.code === "PROVIDER_GATE_BUSY" ||
          error.code === "PROVIDER_GATE_COOLDOWN"
        )
      ) {
        return Object.freeze({
          status: "BACKPRESSURED",
          retryAt: error.retryAt,
          reason:
            error.code === "PROVIDER_GATE_COOLDOWN"
              ? "PROVIDER_COOLDOWN"
              : "PROVIDER_BUSY"
        });
      }
      throw error;
    }

    try {
      await input.poll(input.intent);
      return Object.freeze({
        status: "COMPLETED",
        schedule:
          this.#scheduler.acknowledgeObservationDispatch(
            input.intent.scheduleId,
            input.intent.dispatchId
          )
      });
    } catch (error: unknown) {
      this.#scheduler.abandonClaim(
        input.intent.scheduleId,
        input.intent.dispatchId
      );
      throw error;
    } finally {
      permit.release();
    }
  }
}
