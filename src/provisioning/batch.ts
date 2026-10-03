import type { DatabaseSync } from "node:sqlite";

import {
  BatchStore,
  type BatchCancellationResult,
  type BatchChildSnapshot,
  type BatchSnapshot,
  type BatchStateCounts
} from "../batches/batch-store.js";
import {
  OperationCoordinator,
  type OperationState
} from "../operations/operation-coordinator.js";
import { PROVISIONING_OPERATION_KIND } from "./operation.js";

export type ProvisioningBatchChildResult =
  | "SUCCEEDED"
  | "FAILED_SAFE"
  | "UNCERTAIN"
  | "CANCELLED"
  | "NEEDS_HUMAN"
  | null;

export interface ProvisioningBatchChildInput {
  readonly accountId: string;
  readonly personaUid: string;
  readonly providerIdentity: string;
  readonly credentialRef: string;
}

export interface ProvisioningBatchChild {
  readonly ordinal: number;
  readonly operationId: string;
  readonly input: ProvisioningBatchChildInput;
  readonly state: OperationState;
  readonly result: ProvisioningBatchChildResult;
  readonly cancellationRequestedAt: string | null;
  readonly cancellationOutcome:
    BatchChildSnapshot["cancellationOutcome"];
  readonly cancellationErrorCode: string | null;
}

export interface ProvisioningBatchSnapshot {
  readonly batchId: string;
  readonly actorSource: string;
  readonly label: string | null;
  readonly status: BatchSnapshot["status"];
  readonly cancellationRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly counts: BatchStateCounts;
  readonly children: readonly ProvisioningBatchChild[];
}

export interface CreateProvisioningBatchInput {
  readonly batchId: string;
  readonly actorSource: string;
  readonly label?: string | null;
  readonly operationIds: readonly string[];
}

export type ProvisioningBatchErrorCode =
  | "PROVISIONING_BATCH_INVALID_CHILD"
  | "PROVISIONING_BATCH_DUPLICATE_ACCOUNT"
  | "PROVISIONING_BATCH_ACCOUNT_NOT_FOUND";

export class ProvisioningBatchError extends Error {
  public constructor(
    public readonly code: ProvisioningBatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProvisioningBatchError";
  }
}

function resultForState(
  state: OperationState
): ProvisioningBatchChildResult {
  switch (state) {
    case "SUCCEEDED":
    case "FAILED_SAFE":
    case "UNCERTAIN":
    case "CANCELLED":
    case "NEEDS_HUMAN":
      return state;
    case "PREPARED":
    case "RUNNING":
    case "VERIFYING":
      return null;
  }
}

function provisioningInput(
  child: BatchChildSnapshot
): ProvisioningBatchChildInput {
  const operation = child.operation;
  const expectedIdentity =
    operation.provenance["expectedIdentity"];
  const credentialRef =
    operation.provenance["credentialRef"];

  if (
    operation.operationKind !== PROVISIONING_OPERATION_KIND ||
    operation.accountId === null ||
    operation.personaUid === null ||
    typeof expectedIdentity !== "string" ||
    expectedIdentity.length < 1 ||
    typeof credentialRef !== "string" ||
    credentialRef.length < 1
  ) {
    throw new ProvisioningBatchError(
      "PROVISIONING_BATCH_INVALID_CHILD",
      `operation ${operation.operationId} is not a complete provisioning child`
    );
  }

  return Object.freeze({
    accountId: operation.accountId,
    personaUid: operation.personaUid,
    providerIdentity: expectedIdentity,
    credentialRef
  });
}

function projectChild(
  child: BatchChildSnapshot
): ProvisioningBatchChild {
  const input = provisioningInput(child);
  return Object.freeze({
    ordinal: child.ordinal,
    operationId: child.operation.operationId,
    input,
    state: child.operation.state,
    result: resultForState(child.operation.state),
    cancellationRequestedAt:
      child.cancellationRequestedAt,
    cancellationOutcome:
      child.cancellationOutcome,
    cancellationErrorCode:
      child.cancellationErrorCode
  });
}

export class ProvisioningBatchService {
  readonly #batches: BatchStore;
  readonly #coordinator: OperationCoordinator;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    coordinator?: OperationCoordinator;
    now?: () => Date;
  }>) {
    const coordinator =
      options.coordinator ??
      new OperationCoordinator({
        database: options.database,
        ...(options.now === undefined
          ? {}
          : { now: options.now })
      });
    this.#coordinator = coordinator;
    this.#batches = new BatchStore({
      database: options.database,
      coordinator,
      ...(options.now === undefined
        ? {}
        : { now: options.now })
    });
  }

  public create(
    input: CreateProvisioningBatchInput
  ): ProvisioningBatchSnapshot {
    const accountIds = new Set<string>();
    for (const operationId of input.operationIds) {
      const operation = this.#coordinator.require(operationId);
      const projected = projectChild({
        ordinal: 0,
        operation,
        cancellationRequestedAt: null,
        cancellationOutcome: null,
        cancellationErrorCode: null
      });
      if (accountIds.has(projected.input.accountId)) {
        throw new ProvisioningBatchError(
          "PROVISIONING_BATCH_DUPLICATE_ACCOUNT",
          `provisioning batch contains duplicate Account ${projected.input.accountId}`
        );
      }
      accountIds.add(projected.input.accountId);
    }

    return this.#project(this.#batches.create(input));
  }

  public get(
    batchId: string
  ): ProvisioningBatchSnapshot | null {
    const batch = this.#batches.get(batchId);
    return batch === null ? null : this.#project(batch);
  }

  public require(
    batchId: string
  ): ProvisioningBatchSnapshot {
    return this.#project(this.#batches.require(batchId));
  }

  public requestCancellation(
    batchId: string
  ): ProvisioningBatchSnapshot {
    const result: BatchCancellationResult =
      this.#batches.requestCancellation(batchId);
    return this.#project(result.batch);
  }

  public requestAccountCancellation(
    batchId: string,
    accountId: string
  ): ProvisioningBatchSnapshot {
    const current = this.require(batchId);
    const child = current.children.find(
      (candidate) => candidate.input.accountId === accountId
    );
    if (child === undefined) {
      throw new ProvisioningBatchError(
        "PROVISIONING_BATCH_ACCOUNT_NOT_FOUND",
        `Account ${accountId} is not a member of provisioning batch ${batchId}`
      );
    }
    return this.#project(
      this.#batches.requestChildCancellation(
        batchId,
        child.operationId
      ).batch
    );
  }

  #project(
    batch: BatchSnapshot
  ): ProvisioningBatchSnapshot {
    const children = batch.children.map(projectChild);
    const seen = new Set<string>();
    for (const child of children) {
      if (seen.has(child.input.accountId)) {
        throw new ProvisioningBatchError(
          "PROVISIONING_BATCH_DUPLICATE_ACCOUNT",
          `provisioning batch contains duplicate Account ${child.input.accountId}`
        );
      }
      seen.add(child.input.accountId);
    }

    return Object.freeze({
      batchId: batch.batchId,
      actorSource: batch.actorSource,
      label: batch.label,
      status: batch.status,
      cancellationRequestedAt:
        batch.cancellationRequestedAt,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      revision: batch.revision,
      counts: batch.counts,
      children: Object.freeze(children)
    });
  }
}
