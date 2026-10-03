import {
  HumanTaskStore,
  type HumanTaskRecord
} from "./human-task-store.js";
import {
  OperationCoordinator,
  type OperationRecord
} from "../operations/operation-coordinator.js";

export interface HumanContinuationServiceOptions {
  readonly tasks: HumanTaskStore;
  readonly coordinator: OperationCoordinator;
  readonly focusPersona: (personaUid: string) => void | Promise<void>;
}

export interface ResumeHumanTaskInput {
  readonly taskId: string;
  readonly expectedOperationId: string;
  readonly expectedClaimEpoch: number;
  readonly expectedContinuationRef: string;
  readonly transientInputKind?: string;
}

export interface HumanContinuationResult {
  readonly task: HumanTaskRecord;
  readonly operation: OperationRecord;
  readonly personaUid: string;
  readonly transientInput: string | null;
}

export type HumanContinuationErrorCode =
  | "HUMAN_CONTINUATION_INVALID_TASK"
  | "HUMAN_CONTINUATION_OPERATION_MISMATCH"
  | "HUMAN_CONTINUATION_PERSONA_MISMATCH"
  | "HUMAN_CONTINUATION_DESCRIPTOR_MISMATCH";

export class HumanContinuationError extends Error {
  public constructor(
    public readonly code: HumanContinuationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HumanContinuationError";
  }
}

function fail(
  code: HumanContinuationErrorCode,
  message: string
): never {
  throw new HumanContinuationError(code, message);
}

export class HumanContinuationService {
  readonly #tasks: HumanTaskStore;
  readonly #coordinator: OperationCoordinator;
  readonly #focusPersona: (
    personaUid: string
  ) => void | Promise<void>;

  public constructor(options: HumanContinuationServiceOptions) {
    this.#tasks = options.tasks;
    this.#coordinator = options.coordinator;
    this.#focusPersona = options.focusPersona;
  }

  public async resume(
    input: ResumeHumanTaskInput
  ): Promise<HumanContinuationResult> {
    const task = this.#tasks.require(input.taskId);
    if (task.status !== "OPEN") {
      fail(
        "HUMAN_CONTINUATION_INVALID_TASK",
        `HumanTask ${task.taskId} is not open`
      );
    }
    if (
      task.operationId === null ||
      task.operationId !== input.expectedOperationId
    ) {
      fail(
        "HUMAN_CONTINUATION_OPERATION_MISMATCH",
        "HumanTask is not linked to the expected operation"
      );
    }
    if (task.personaUid === null) {
      fail(
        "HUMAN_CONTINUATION_PERSONA_MISMATCH",
        "HumanTask has no Persona to resume"
      );
    }
    if (task.continuation.ref !== input.expectedContinuationRef) {
      fail(
        "HUMAN_CONTINUATION_DESCRIPTOR_MISMATCH",
        "HumanTask continuation reference changed"
      );
    }

    const operation = this.#coordinator.require(
      input.expectedOperationId
    );
    if (
      operation.state !== "NEEDS_HUMAN" ||
      operation.claimEpoch !== input.expectedClaimEpoch
    ) {
      fail(
        "HUMAN_CONTINUATION_OPERATION_MISMATCH",
        "operation is not the expected human-blocked claim"
      );
    }
    if (
      operation.personaUid === null ||
      operation.personaUid !== task.personaUid
    ) {
      fail(
        "HUMAN_CONTINUATION_PERSONA_MISMATCH",
        "HumanTask Persona does not match the linked operation"
      );
    }

    // Focus is deliberately before consuming one-time input or changing durable
    // operation state. A focus failure leaves the continuation retryable.
    await this.#focusPersona(task.personaUid);

    const transientInput =
      input.transientInputKind === undefined
        ? null
        : this.#tasks.consumeTransientInput(
            task.taskId,
            input.transientInputKind
          );

    const resumed = this.#coordinator.beginReconciliation(
      operation.operationId,
      input.expectedClaimEpoch,
      "human-continuation-resumed"
    );
    const resolvedTask = this.#tasks.resolve(task.taskId);

    return Object.freeze({
      task: resolvedTask,
      operation: resumed,
      personaUid: task.personaUid,
      transientInput
    });
  }
}
