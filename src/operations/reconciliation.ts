import {
  OperationCoordinator,
  type OperationRecord
} from "./operation-coordinator.js";

export type OperationReconciliationOutcome =
  | Readonly<{ kind: "CONFIRMED_APPLIED"; reason: string }>
  | Readonly<{ kind: "CONFIRMED_NOT_APPLIED"; reason: string }>
  | Readonly<{ kind: "NEEDS_HUMAN"; reason: string }>
  | Readonly<{ kind: "UNKNOWN"; reason: string }>;

export interface ReconcileOperationInput {
  readonly operationId: string;
  readonly expectedClaimEpoch: number;
  readonly read: () =>
    | OperationReconciliationOutcome
    | Promise<OperationReconciliationOutcome>;
}

export interface ReconcileOperationResult {
  readonly outcome: OperationReconciliationOutcome;
  readonly operation: OperationRecord;
}

function normalizeOutcome(
  outcome: OperationReconciliationOutcome
): OperationReconciliationOutcome {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    !(
      outcome.kind === "CONFIRMED_APPLIED" ||
      outcome.kind === "CONFIRMED_NOT_APPLIED" ||
      outcome.kind === "NEEDS_HUMAN" ||
      outcome.kind === "UNKNOWN"
    ) ||
    typeof outcome.reason !== "string" ||
    outcome.reason.trim().length < 1 ||
    outcome.reason.trim().length > 256
  ) {
    throw new TypeError("reconciliation read returned an invalid outcome");
  }
  return Object.freeze({
    kind: outcome.kind,
    reason: outcome.reason.trim()
  });
}

export class OperationReconciler {
  readonly #coordinator: OperationCoordinator;

  public constructor(coordinator: OperationCoordinator) {
    this.#coordinator = coordinator;
  }

  public async reconcile(
    input: ReconcileOperationInput
  ): Promise<ReconcileOperationResult> {
    this.#coordinator.beginReconciliation(
      input.operationId,
      input.expectedClaimEpoch,
      "read-first-reconciliation-started"
    );

    let outcome: OperationReconciliationOutcome;
    try {
      outcome = normalizeOutcome(await input.read());
    } catch {
      outcome = Object.freeze({
        kind: "UNKNOWN",
        reason: "reconciliation-read-failed"
      });
    }

    let operation: OperationRecord;
    switch (outcome.kind) {
      case "CONFIRMED_APPLIED":
        operation = this.#coordinator.markSucceeded(
          input.operationId,
          input.expectedClaimEpoch,
          outcome.reason
        );
        break;
      case "CONFIRMED_NOT_APPLIED":
        operation = this.#coordinator.markFailedSafe(
          input.operationId,
          input.expectedClaimEpoch,
          outcome.reason
        );
        break;
      case "NEEDS_HUMAN":
        operation = this.#coordinator.markNeedsHuman(
          input.operationId,
          input.expectedClaimEpoch,
          outcome.reason
        );
        break;
      case "UNKNOWN":
        operation = this.#coordinator.markUncertain(
          input.operationId,
          input.expectedClaimEpoch,
          outcome.reason
        );
        break;
    }

    return Object.freeze({ outcome, operation });
  }
}
