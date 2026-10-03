import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  type AccountRecord
} from "../accounts/account-repository.js";
import {
  BrowserDriverError,
  type BrowserPage
} from "../browser/browser-driver.js";
import {
  HumanContinuationService
} from "../human-tasks/human-continuation.js";
import {
  HumanTaskStore,
  type HumanTaskRecord
} from "../human-tasks/human-task-store.js";
import {
  OperationCoordinator,
  accountOperationTargetKey,
  type OperationOwner,
  type OperationRecord
} from "../operations/operation-coordinator.js";
import {
  ProvisioningBrowserFlow,
  ProvisioningBrowserFlowError,
  type ProvisioningBrowserFlowResult,
  type ProvisioningHumanRequirement,
  type ProvisioningIdentityVerification
} from "./browser-flow.js";

export const PROVISIONING_PROVISIONING_OPERATION_KIND = "provisioning.account";
const OPERATION_SCHEMA_VERSION = 1;
const PRECONDITION_MAX_AGE_MS = 60_000;
const MAX_IDENTITY_LENGTH = 320;
const MAX_CREDENTIAL_REF_LENGTH = 512;
const TRANSIENT_CODE_TTL_MS = 5 * 60 * 1000;

export type ProvisioningCredentialResolver = (
  credentialRef: string
) => string | Promise<string>;

export interface ProvisioningOperationInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly personaUid: string;
  readonly providerIdentity: string;
  readonly credentialRef: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly page: BrowserPage;
  readonly resolveCredential: ProvisioningCredentialResolver;
  readonly commandTimeoutMs?: number;
}

export interface ResumeProvisioningHumanTaskInput {
  readonly taskId: string;
  readonly page: BrowserPage;
  readonly resolveCredential: ProvisioningCredentialResolver;
  readonly verificationCode?: string;
  readonly commandTimeoutMs?: number;
}

export interface ReconcileProvisioningInput {
  readonly operationId: string;
  readonly page: BrowserPage;
  readonly resolveCredential: ProvisioningCredentialResolver;
  readonly commandTimeoutMs?: number;
}

export type ProvisioningOperationDisposition =
  | "ACTIVE"
  | "HUMAN_REQUIRED"
  | "NOT_APPLIED";

export interface ProvisioningOperationResult {
  readonly disposition: ProvisioningOperationDisposition;
  readonly operation: OperationRecord;
  readonly account: AccountRecord;
  readonly task: HumanTaskRecord | null;
}

export type ProvisioningOperationErrorCode =
  | "PROVISIONING_OPERATION_INVALID_INPUT"
  | "PROVISIONING_OPERATION_ACCOUNT_UNAVAILABLE"
  | "PROVISIONING_OPERATION_CONFLICT"
  | "PROVISIONING_OPERATION_UNRESOLVED"
  | "PROVISIONING_OPERATION_MUTATION_FAILED";

export class ProvisioningOperationError extends Error {
  public constructor(
    public readonly code: ProvisioningOperationErrorCode,
    message: string,
    public readonly operationId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProvisioningOperationError";
  }
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function normalizeIdentity(
  value: string,
  operationId: string
): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_IDENTITY_LENGTH ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new ProvisioningOperationError(
      "PROVISIONING_OPERATION_INVALID_INPUT",
      "Provisioning provider identity is invalid",
      operationId
    );
  }
  return normalized;
}

function normalizeCredentialRef(
  value: string,
  operationId: string
): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_CREDENTIAL_REF_LENGTH ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new ProvisioningOperationError(
      "PROVISIONING_OPERATION_INVALID_INPUT",
      "Provisioning credential reference is invalid",
      operationId
    );
  }
  return normalized;
}

function desiredFingerprint(
  accountId: string,
  personaUid: string,
  providerIdentity: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      accountId,
      personaUid,
      providerIdentity: asciiLowercase(providerIdentity)
    }))
    .digest("hex");
}

function sameOwner(left: OperationOwner, right: OperationOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "CORE" && right.kind === "CORE") return true;
  return (
    left.kind === "MODULE" &&
    right.kind === "MODULE" &&
    left.moduleId === right.moduleId &&
    left.moduleVersion === right.moduleVersion &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function commandOptions(
  timeoutMs: number | undefined
): Readonly<{ timeoutMs?: number }> {
  return timeoutMs === undefined ? Object.freeze({}) : Object.freeze({ timeoutMs });
}

function humanTaskHash(
  operation: OperationRecord,
  challengeRef: string
): string {
  return createHash("sha256")
    .update(`${operation.operationId}:${operation.revision}:${challengeRef}`)
    .digest("hex")
    .slice(0, 24);
}

export class ProvisioningOperationService {
  readonly #accounts: AccountRepository;
  readonly #coordinator: OperationCoordinator;
  readonly #tasks: HumanTaskStore;
  readonly #flow: ProvisioningBrowserFlow;
  readonly #now: () => Date;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    coordinator?: OperationCoordinator;
    tasks?: HumanTaskStore;
    flow?: ProvisioningBrowserFlow;
    now?: () => Date;
  }>) {
    const timed = {
      database: options.database,
      ...(options.now === undefined ? {} : { now: options.now })
    };
    this.#accounts = new AccountRepository(timed);
    this.#coordinator =
      options.coordinator ??
      new OperationCoordinator(timed);
    this.#tasks =
      options.tasks ??
      new HumanTaskStore(timed);
    this.#flow = options.flow ?? new ProvisioningBrowserFlow();
    this.#now = options.now ?? (() => new Date());
  }

  public get tasks(): HumanTaskStore {
    return this.#tasks;
  }

  public async provision(
    input: ProvisioningOperationInput
  ): Promise<ProvisioningOperationResult> {
    const providerIdentity = normalizeIdentity(
      input.providerIdentity,
      input.operationId
    );
    const credentialRef = normalizeCredentialRef(
      input.credentialRef,
      input.operationId
    );
    this.#assertPagePersona(
      input.page,
      input.personaUid,
      input.operationId
    );
    const account = this.#requireAccountBinding(
      input.accountId,
      input.personaUid,
      input.operationId
    );

    const byOperationId = this.#coordinator.get(input.operationId);
    const byIdempotency = this.#coordinator.getByIdempotencyKey(
      input.idempotencyKey
    );
    if (
      byOperationId !== null &&
      byIdempotency !== null &&
      byOperationId.operationId !== byIdempotency.operationId
    ) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_CONFLICT",
        "operationId and idempotencyKey refer to different provisioning operations",
        input.operationId
      );
    }

    const existing = byOperationId ?? byIdempotency;
    if (existing !== null) {
      if (!this.#sameIntent(existing, input, providerIdentity, credentialRef)) {
        throw new ProvisioningOperationError(
          "PROVISIONING_OPERATION_CONFLICT",
          "existing provisioning operation is bound to different intent",
          existing.operationId
        );
      }
      if (existing.state === "UNCERTAIN") {
        return this.#reconcileExisting(
          existing,
          input.page,
          input.resolveCredential,
          input.commandTimeoutMs
        );
      }
      if (existing.state === "NEEDS_HUMAN") {
        const task = this.#openTaskForOperation(existing.operationId);
        if (task === null) {
          throw new ProvisioningOperationError(
            "PROVISIONING_OPERATION_UNRESOLVED",
            "human-blocked provisioning operation has no open HumanTask",
            existing.operationId
          );
        }
        return Object.freeze({
          disposition: "HUMAN_REQUIRED",
          operation: existing,
          account: this.#accounts.require(input.accountId),
          task
        });
      }
      if (existing.state === "SUCCEEDED") {
        const current = this.#accounts.require(input.accountId);
        if (
          current.lifecycleStatus !== "ACTIVE" ||
          current.personaUid !== input.personaUid
        ) {
          throw new ProvisioningOperationError(
            "PROVISIONING_OPERATION_UNRESOLVED",
            "completed provisioning operation no longer matches ACTIVE Account state",
            existing.operationId
          );
        }
        return Object.freeze({
          disposition: "ACTIVE",
          operation: existing,
          account: current,
          task: null
        });
      }
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        `existing provisioning operation is ${existing.state} and cannot be redispatched`,
        existing.operationId
      );
    }

    if (account.lifecycleStatus !== "INACTIVE") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_ACCOUNT_UNAVAILABLE",
        "new provisioning requires an INACTIVE Account",
        input.operationId
      );
    }

    const observedAt = this.#currentIso(input.operationId);
    const operation = this.#coordinator.prepare({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      owner: input.owner,
      actorSource: input.actorSource,
      targetKey: accountOperationTargetKey(input.accountId),
      operationKind: PROVISIONING_PROVISIONING_OPERATION_KIND,
      schemaVersion: OPERATION_SCHEMA_VERSION,
      accountId: input.accountId,
      personaUid: input.personaUid,
      desiredFingerprint: desiredFingerprint(
        input.accountId,
        input.personaUid,
        providerIdentity
      ),
      provenance: {
        source: "provisioning",
        expectedIdentity: providerIdentity,
        credentialRef
      },
      preconditions: [{
        key: "accountBinding",
        observedAt,
        maxAgeMs: PRECONDITION_MAX_AGE_MS,
        evidenceRef:
          `account:${account.accountId}:rev:${account.revision}`
      }]
    });

    const gate = this.#coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: input.accountId,
      personaUid: input.personaUid
    });
    try {
      this.#coordinator.authorizeDispatch({
        operationId: operation.operationId,
        expectedClaimEpoch: operation.claimEpoch,
        evidence: {
          provider: "perchance",
          action: "signup"
        }
      });

      let result: ProvisioningBrowserFlowResult;
      try {
        const password = await input.resolveCredential(credentialRef);
        result = await this.#flow.signup(
          input.page,
          { providerIdentity, password },
          commandOptions(input.commandTimeoutMs)
        );
      } catch (error: unknown) {
        const effectState =
          error instanceof BrowserDriverError
            ? error.effectState
            : error instanceof ProvisioningBrowserFlowError &&
                error.code === "PROVISIONING_BROWSER_PROVIDER_REJECTED"
              ? "NOT_DISPATCHED"
              : "MAY_HAVE_OCCURRED";
        const lost = this.#coordinator.recordExecutionLoss({
          operationId: operation.operationId,
          expectedClaimEpoch: operation.claimEpoch,
          source: "BROWSER",
          effectState
        });
        if (effectState === "MAY_HAVE_OCCURRED") {
          return this.#reconcileWithinGate(
            lost,
            input.page,
            input.resolveCredential,
            input.commandTimeoutMs
          );
        }
        throw new ProvisioningOperationError(
          "PROVISIONING_OPERATION_MUTATION_FAILED",
          "Provisioning signup failed before a new remote account effect",
          operation.operationId,
          error instanceof Error ? { cause: error } : undefined
        );
      }

      return this.#processFlowResult(
        this.#coordinator.require(operation.operationId),
        result,
        input.page,
        providerIdentity,
        input.commandTimeoutMs
      );
    } finally {
      gate.release();
    }
  }

  public async resumeHumanTask(
    input: ResumeProvisioningHumanTaskInput
  ): Promise<ProvisioningOperationResult> {
    const task = this.#tasks.require(input.taskId);
    if (task.operationId === null || task.personaUid === null) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning HumanTask is not linked to an operation and Persona",
        task.operationId ?? input.taskId
      );
    }
    const operation = this.#coordinator.require(task.operationId);
    if (operation.accountId === null || operation.personaUid === null) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning HumanTask operation lost its Account or Persona identity",
        operation.operationId
      );
    }
    const providerIdentity = this.#operationIdentity(operation);
    this.#assertPagePersona(input.page, task.personaUid, operation.operationId);

    const isCode =
      task.requiredActionKind === "ENTER_VERIFICATION_CODE";
    if (isCode) {
      if (input.verificationCode === undefined) {
        throw new ProvisioningOperationError(
          "PROVISIONING_OPERATION_INVALID_INPUT",
          "Verification-code HumanTask requires transient operator input",
          operation.operationId
        );
      }
      this.#tasks.submitTransientInput(
        task.taskId,
        "VERIFICATION_CODE",
        input.verificationCode,
        TRANSIENT_CODE_TTL_MS
      );
    }

    const continuation = new HumanContinuationService({
      tasks: this.#tasks,
      coordinator: this.#coordinator,
      focusPersona: async (personaUid) => {
        this.#assertPagePersona(
          input.page,
          personaUid,
          operation.operationId
        );
        await input.page.focus(commandOptions(input.commandTimeoutMs));
      }
    });
    const resumed = await continuation.resume({
      taskId: task.taskId,
      expectedOperationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      expectedContinuationRef: task.continuation.ref,
      ...(isCode ? { transientInputKind: "VERIFICATION_CODE" } : {})
    });

    const gate = this.#coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: operation.accountId,
      personaUid: operation.personaUid
    });
    try {
      if (isCode) {
        if (resumed.transientInput === null) {
          throw new ProvisioningOperationError(
            "PROVISIONING_OPERATION_UNRESOLVED",
            "Verification-code continuation lost its transient input",
            operation.operationId
          );
        }
        try {
          await this.#flow.submitVerificationCode(
            input.page,
            resumed.transientInput,
            commandOptions(input.commandTimeoutMs)
          );
        } catch (error: unknown) {
          if (
            error instanceof ProvisioningBrowserFlowError &&
            error.code === "PROVISIONING_BROWSER_PROVIDER_REJECTED"
          ) {
            return this.#pauseForHuman(
              this.#coordinator.require(operation.operationId),
              {
                kind: "VERIFICATION_CODE",
                challengeRef: `retry-${humanTaskHash(operation, task.taskId)}`
              }
            );
          }
          this.#coordinator.markUncertain(
            operation.operationId,
            operation.claimEpoch,
            "provisioning-verification-code-outcome-unknown"
          );
          throw new ProvisioningOperationError(
            "PROVISIONING_OPERATION_UNRESOLVED",
            "Verification-code outcome is uncertain and requires read-first reconciliation",
            operation.operationId,
            error instanceof Error ? { cause: error } : undefined
          );
        }
      }

      return this.#verifyAndActivate(
        this.#coordinator.require(operation.operationId),
        input.page,
        providerIdentity,
        input.commandTimeoutMs
      );
    } finally {
      gate.release();
    }
  }

  public async reconcileInterrupted(
    input: ReconcileProvisioningInput
  ): Promise<ProvisioningOperationResult> {
    const operation = this.#coordinator.require(input.operationId);
    if (operation.state !== "UNCERTAIN") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        `provisioning reconciliation requires UNCERTAIN state, found ${operation.state}`,
        operation.operationId
      );
    }
    if (operation.personaUid === null || operation.accountId === null) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation lost its Account or Persona identity",
        operation.operationId
      );
    }
    this.#assertPagePersona(
      input.page,
      operation.personaUid,
      operation.operationId
    );
    this.#requireAccountBinding(
      operation.accountId,
      operation.personaUid,
      operation.operationId
    );

    const gate = this.#coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: operation.accountId,
      personaUid: operation.personaUid
    });
    try {
      return this.#reconcileWithinGate(
        operation,
        input.page,
        input.resolveCredential,
        input.commandTimeoutMs
      );
    } finally {
      gate.release();
    }
  }

  async #reconcileExisting(
    operation: OperationRecord,
    page: BrowserPage,
    resolveCredential: ProvisioningCredentialResolver,
    commandTimeoutMs: number | undefined
  ): Promise<ProvisioningOperationResult> {
    if (operation.accountId === null || operation.personaUid === null) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation lost its Account or Persona identity",
        operation.operationId
      );
    }
    const gate = this.#coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: operation.accountId,
      personaUid: operation.personaUid
    });
    try {
      return this.#reconcileWithinGate(
        operation,
        page,
        resolveCredential,
        commandTimeoutMs
      );
    } finally {
      gate.release();
    }
  }

  async #reconcileWithinGate(
    operation: OperationRecord,
    page: BrowserPage,
    resolveCredential: ProvisioningCredentialResolver,
    commandTimeoutMs: number | undefined
  ): Promise<ProvisioningOperationResult> {
    if (
      operation.state !== "UNCERTAIN" ||
      operation.accountId === null ||
      operation.personaUid === null
    ) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation is not a recoverable uncertain Account claim",
        operation.operationId
      );
    }
    const providerIdentity = this.#operationIdentity(operation);
    const credentialRef = this.#operationCredentialRef(operation);
    this.#assertPagePersona(page, operation.personaUid, operation.operationId);
    this.#requireAccountBinding(
      operation.accountId,
      operation.personaUid,
      operation.operationId
    );

    let verifying = this.#coordinator.beginReconciliation(
      operation.operationId,
      operation.claimEpoch,
      "provisioning-read-first-reconciliation"
    );

    let session: ProvisioningIdentityVerification;
    try {
      session = await this.#flow.verifyAuthenticatedIdentity(
        page,
        providerIdentity,
        commandOptions(commandTimeoutMs)
      );
    } catch (error: unknown) {
      this.#coordinator.markUncertain(
        operation.operationId,
        operation.claimEpoch,
        "provisioning-session-reconciliation-read-failed"
      );
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning session could not be reconciled safely",
        operation.operationId,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    if (session.verification === "VERIFIED") {
      return this.#activate(
        verifying,
        providerIdentity
      );
    }
    if (session.verification === "MISMATCH") {
      return this.#pauseForIdentityReview(verifying, session);
    }

    let existence;
    try {
      existence = await this.#flow.probeIdentity(
        page,
        providerIdentity,
        commandOptions(commandTimeoutMs)
      );
    } catch (error: unknown) {
      this.#coordinator.markUncertain(
        operation.operationId,
        operation.claimEpoch,
        "provisioning-identity-reconciliation-read-failed"
      );
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning provider identity existence could not be reconciled",
        operation.operationId,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    if (!existence.exists) {
      const terminal = this.#coordinator.markFailedSafe(
        operation.operationId,
        operation.claimEpoch,
        "provisioning-signup-confirmed-not-applied"
      );
      return Object.freeze({
        disposition: "NOT_APPLIED",
        operation: terminal,
        account: this.#accounts.require(operation.accountId),
        task: null
      });
    }

    try {
      const password = await resolveCredential(credentialRef);
      const login = await this.#flow.login(
        page,
        { providerIdentity, password },
        commandOptions(commandTimeoutMs)
      );
      verifying = this.#coordinator.require(operation.operationId);
      return this.#processFlowResult(
        verifying,
        login,
        page,
        providerIdentity,
        commandTimeoutMs
      );
    } catch (error: unknown) {
      if (
        error instanceof ProvisioningBrowserFlowError &&
        error.code === "PROVISIONING_BROWSER_PROVIDER_REJECTED"
      ) {
        const terminal = this.#coordinator.markFailedSafe(
          operation.operationId,
          operation.claimEpoch,
          "provisioning-login-rejected-after-read-first-recovery"
        );
        return Object.freeze({
          disposition: "NOT_APPLIED",
          operation: terminal,
          account: this.#accounts.require(operation.accountId),
          task: null
        });
      }

      const uncertain = this.#coordinator.markUncertain(
        operation.operationId,
        operation.claimEpoch,
        "provisioning-login-outcome-unknown"
      );
      if (
        error instanceof BrowserDriverError &&
        error.effectState === "MAY_HAVE_OCCURRED"
      ) {
        const secondVerify = this.#coordinator.beginReconciliation(
          uncertain.operationId,
          uncertain.claimEpoch,
          "provisioning-login-read-first-reconciliation"
        );
        try {
          const afterLoss = await this.#flow.verifyAuthenticatedIdentity(
            page,
            providerIdentity,
            commandOptions(commandTimeoutMs)
          );
          if (afterLoss.verification === "VERIFIED") {
            return this.#activate(secondVerify, providerIdentity);
          }
          if (afterLoss.verification === "MISMATCH") {
            return this.#pauseForIdentityReview(secondVerify, afterLoss);
          }
        } catch {
          // The outcome remains unknown below.
        }
        this.#coordinator.markUncertain(
          uncertain.operationId,
          uncertain.claimEpoch,
          "provisioning-login-reconciliation-inconclusive"
        );
      }
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning login outcome remains uncertain; automatic signup redispatch is blocked",
        operation.operationId,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  async #processFlowResult(
    operation: OperationRecord,
    result: ProvisioningBrowserFlowResult,
    page: BrowserPage,
    providerIdentity: string,
    commandTimeoutMs: number | undefined
  ): Promise<ProvisioningOperationResult> {
    if ("humanRequired" in result) {
      return this.#pauseForHuman(operation, result.humanRequired);
    }

    let verifying = operation;
    if (verifying.state === "RUNNING") {
      verifying = this.#coordinator.beginVerification(
        verifying.operationId,
        verifying.claimEpoch,
        "provisioning-provider-response-received"
      );
    }
    if (verifying.state !== "VERIFYING") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        `provisioning identity verification cannot continue from ${verifying.state}`,
        verifying.operationId
      );
    }
    return this.#verifyAndActivate(
      verifying,
      page,
      providerIdentity,
      commandTimeoutMs
    );
  }

  async #verifyAndActivate(
    operation: OperationRecord,
    page: BrowserPage,
    providerIdentity: string,
    commandTimeoutMs: number | undefined
  ): Promise<ProvisioningOperationResult> {
    let verification: ProvisioningIdentityVerification;
    try {
      verification = await this.#flow.verifyAuthenticatedIdentity(
        page,
        providerIdentity,
        commandOptions(commandTimeoutMs)
      );
    } catch (error: unknown) {
      this.#coordinator.markUncertain(
        operation.operationId,
        operation.claimEpoch,
        "provisioning-authenticated-identity-read-failed"
      );
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Authenticated provisioning identity could not be verified",
        operation.operationId,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    if (verification.verification === "VERIFIED") {
      return this.#activate(operation, providerIdentity);
    }
    if (verification.verification === "MISMATCH") {
      return this.#pauseForIdentityReview(operation, verification);
    }

    this.#coordinator.markUncertain(
      operation.operationId,
      operation.claimEpoch,
      "provisioning-authenticated-identity-unverified"
    );
    throw new ProvisioningOperationError(
      "PROVISIONING_OPERATION_UNRESOLVED",
      "Provider response did not establish an authenticated matching identity",
      operation.operationId
    );
  }

  #activate(
    operation: OperationRecord,
    providerIdentity: string
  ): ProvisioningOperationResult {
    if (operation.accountId === null || operation.personaUid === null) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation lost Account or Persona identity before activation",
        operation.operationId
      );
    }
    const account = this.#accounts.require(operation.accountId);
    const active = this.#accounts.activateVerified({
      accountId: operation.accountId,
      personaUid: operation.personaUid,
      expectedRevision: account.revision
    });
    const terminal = this.#coordinator.markSucceeded(
      operation.operationId,
      operation.claimEpoch,
      "provisioning-authenticated-identity-verified"
    );
    if (asciiLowercase(this.#operationIdentity(terminal)) !==
        asciiLowercase(providerIdentity)) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation identity changed during activation",
        operation.operationId
      );
    }
    return Object.freeze({
      disposition: "ACTIVE",
      operation: terminal,
      account: active,
      task: null
    });
  }

  #pauseForHuman(
    operation: OperationRecord,
    requirement: ProvisioningHumanRequirement
  ): ProvisioningOperationResult {
    let verifying = operation;
    if (verifying.state === "RUNNING") {
      verifying = this.#coordinator.beginVerification(
        verifying.operationId,
        verifying.claimEpoch,
        "provisioning-human-verification-required"
      );
    }
    if (verifying.state !== "VERIFYING") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning HumanTask can only be created while verifying",
        operation.operationId
      );
    }
    const blocked = this.#coordinator.markNeedsHuman(
      verifying.operationId,
      verifying.claimEpoch,
      requirement.kind === "CAPTCHA"
        ? "provisioning-captcha-required"
        : "provisioning-verification-code-required"
    );
    const hash = humanTaskHash(blocked, requirement.challengeRef);
    const task = this.#tasks.create({
      taskId: `provisioning-${hash}`,
      taskType:
        requirement.kind === "CAPTCHA"
          ? "PROVISIONING_CHALLENGE"
          : "PROVISIONING_VERIFICATION_CODE",
      accountId: blocked.accountId,
      personaUid: blocked.personaUid,
      operationId: blocked.operationId,
      title:
        requirement.kind === "CAPTCHA"
          ? "Complete provisioning challenge"
          : "Enter provisioning verification code",
      explanation:
        requirement.kind === "CAPTCHA"
          ? "Complete the provider challenge in the existing Persona, then continue the same provisioning operation."
          : "Supply the one-time provider verification code to continue the same provisioning operation.",
      requiredActionKind:
        requirement.kind === "CAPTCHA"
          ? "COMPLETE_BROWSER_CHALLENGE"
          : "ENTER_VERIFICATION_CODE",
      continuation: {
        kind:
          requirement.kind === "CAPTCHA"
            ? "PROVISIONING_CHALLENGE"
            : "PROVISIONING_VERIFICATION_CODE",
        version: 1,
        ref: `p039:${hash}`
      },
      evidence: {
        provider: "perchance",
        challengeKind: requirement.kind,
        challengeRef: requirement.challengeRef,
        expectedIdentity: this.#operationIdentity(blocked)
      }
    });
    return Object.freeze({
      disposition: "HUMAN_REQUIRED",
      operation: blocked,
      account: this.#accounts.require(blocked.accountId ?? ""),
      task
    });
  }

  #pauseForIdentityReview(
    operation: OperationRecord,
    verification: Extract<
      ProvisioningIdentityVerification,
      { verification: "MISMATCH" }
    >
  ): ProvisioningOperationResult {
    const blocked = this.#coordinator.markNeedsHuman(
      operation.operationId,
      operation.claimEpoch,
      "provisioning-authenticated-identity-mismatch"
    );
    const hash = humanTaskHash(
      blocked,
      `identity:${verification.observedIdentity}`
    );
    const task = this.#tasks.create({
      taskId: `provisioning-${hash}`,
      taskType: "PROVISIONING_IDENTITY_MISMATCH",
      accountId: blocked.accountId,
      personaUid: blocked.personaUid,
      operationId: blocked.operationId,
      title: "Review provisioning account identity",
      explanation:
        "The authenticated provider identity does not match the staged Account. Correct the session in the same Persona before continuing.",
      requiredActionKind: "REVIEW_ACCOUNT_IDENTITY",
      continuation: {
        kind: "PROVISIONING_IDENTITY_REVIEW",
        version: 1,
        ref: `p039:${hash}`
      },
      evidence: {
        provider: "perchance",
        expectedIdentity: this.#operationIdentity(blocked),
        observedIdentity: verification.observedIdentity
      }
    });
    return Object.freeze({
      disposition: "HUMAN_REQUIRED",
      operation: blocked,
      account: this.#accounts.require(blocked.accountId ?? ""),
      task
    });
  }

  #sameIntent(
    operation: OperationRecord,
    input: ProvisioningOperationInput,
    providerIdentity: string,
    credentialRef: string
  ): boolean {
    return (
      operation.idempotencyKey === input.idempotencyKey &&
      operation.targetKey === accountOperationTargetKey(input.accountId) &&
      operation.operationKind === PROVISIONING_OPERATION_KIND &&
      operation.schemaVersion === OPERATION_SCHEMA_VERSION &&
      sameOwner(operation.owner, input.owner) &&
      operation.actorSource === input.actorSource &&
      operation.accountId === input.accountId &&
      operation.personaUid === input.personaUid &&
      operation.desiredFingerprint === desiredFingerprint(
        input.accountId,
        input.personaUid,
        providerIdentity
      ) &&
      operation.provenance["source"] === "provisioning" &&
      operation.provenance["expectedIdentity"] === providerIdentity &&
      operation.provenance["credentialRef"] === credentialRef
    );
  }

  #operationIdentity(operation: OperationRecord): string {
    const value = operation.provenance["expectedIdentity"];
    if (typeof value !== "string") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation has no durable expected provider identity",
        operation.operationId
      );
    }
    return normalizeIdentity(value, operation.operationId);
  }

  #operationCredentialRef(operation: OperationRecord): string {
    const value = operation.provenance["credentialRef"];
    if (typeof value !== "string") {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_UNRESOLVED",
        "Provisioning operation has no durable credential reference",
        operation.operationId
      );
    }
    return normalizeCredentialRef(value, operation.operationId);
  }

  #requireAccountBinding(
    accountId: string,
    personaUid: string,
    operationId: string
  ): AccountRecord {
    const account = this.#accounts.require(accountId);
    if (account.personaUid !== personaUid) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_ACCOUNT_UNAVAILABLE",
        "Provisioning requires the Account's dedicated Persona binding",
        operationId
      );
    }
    return account;
  }

  #assertPagePersona(
    page: BrowserPage,
    personaUid: string,
    operationId: string
  ): void {
    if (page.personaUid !== personaUid) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_ACCOUNT_UNAVAILABLE",
        "Provisioning page does not belong to the Account's dedicated Persona",
        operationId
      );
    }
  }

  #openTaskForOperation(operationId: string): HumanTaskRecord | null {
    return this.#tasks.listOpen().find((task) =>
      task.operationId === operationId
    ) ?? null;
  }

  #currentIso(operationId: string): string {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new ProvisioningOperationError(
        "PROVISIONING_OPERATION_INVALID_INPUT",
        "Provisioning clock returned an invalid time",
        operationId
      );
    }
    return value.toISOString();
  }
}
