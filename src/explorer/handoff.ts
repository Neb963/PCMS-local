import type { DatabaseSync } from "node:sqlite";

import {
  GeneratorRepository,
  type GeneratorRecord
} from "../generators/generator-repository.js";
import {
  ProjectRepository,
  type ProjectRecord
} from "../projects/project-repository.js";
import type {
  ExplorerClaimResult,
  ExplorerReservationRecord
} from "./claim.js";

export interface ExplorerHandoffInput {
  readonly claim: ExplorerClaimResult;
  readonly generatorLocalId: string;
  readonly projectId: string;
}

export interface ExplorerHandoffResult {
  readonly generator: GeneratorRecord;
  readonly project: ProjectRecord;
  readonly reservation: ExplorerReservationRecord;
}

export class ExplorerHandoffError extends Error {
  public constructor(
    public readonly code:
      | "EXPLORER_HANDOFF_UNVERIFIED"
      | "EXPLORER_HANDOFF_IDENTITY_CONFLICT"
      | "EXPLORER_HANDOFF_FAILED",
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExplorerHandoffError";
  }
}

function validateClaim(
  claim: ExplorerClaimResult
): ExplorerReservationRecord {
  const reservation = claim.reservation;
  if (
    claim.operation.state !== "SUCCEEDED" ||
    reservation.ownership !== "VERIFIED" ||
    claim.operation.operationId !== reservation.operationId ||
    claim.operation.claimEpoch !== reservation.claimEpoch ||
    claim.operation.accountId !== reservation.accountId ||
    claim.operation.personaUid !== reservation.personaUid ||
    typeof reservation.providerStableId !== "string" ||
    reservation.providerStableId.length < 1 ||
    reservation.providerStableId.length > 256 ||
    typeof reservation.slug !== "string" ||
    reservation.slug.length < 1 ||
    reservation.slug.length > 512
  ) {
    throw new ExplorerHandoffError(
      "EXPLORER_HANDOFF_UNVERIFIED",
      "Explorer handoff requires a completed claim with verified ownership evidence"
    );
  }
  return reservation;
}

export class ExplorerHandoffService {
  readonly #database: DatabaseSync;
  readonly #generators: GeneratorRepository;
  readonly #projects: ProjectRepository;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    now?: () => Date;
  }>) {
    this.#database = options.database;
    this.#generators = new GeneratorRepository({
      database: options.database,
      now: options.now
    });
    this.#projects = new ProjectRepository({
      database: options.database,
      now: options.now
    });
  }

  public handoff(
    input: ExplorerHandoffInput
  ): ExplorerHandoffResult {
    const reservation = validateClaim(input.claim);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      let generator = this.#generators.get(input.generatorLocalId);
      if (generator === null) {
        generator = this.#generators.create({
          generatorLocalId: input.generatorLocalId,
          accountId: reservation.accountId,
          providerStableId: reservation.providerStableId,
          currentSlug: reservation.slug
        });
      } else if (
        generator.accountId !== reservation.accountId ||
        generator.providerStableId !== reservation.providerStableId ||
        generator.currentSlug !== reservation.slug
      ) {
        throw new ExplorerHandoffError(
          "EXPLORER_HANDOFF_IDENTITY_CONFLICT",
          "Existing Generator local identity does not match the verified Explorer acquisition"
        );
      }

      let project = this.#projects.get(input.projectId);
      if (project === null) {
        project = this.#projects.create({
          projectId: input.projectId,
          generatorLocalId: generator.generatorLocalId
        });
      } else if (
        project.generatorLocalId !== generator.generatorLocalId
      ) {
        throw new ExplorerHandoffError(
          "EXPLORER_HANDOFF_IDENTITY_CONFLICT",
          "Existing Project identity is linked to a different Generator"
        );
      }

      this.#database.exec("COMMIT");
      return Object.freeze({
        generator,
        project,
        reservation
      });
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      if (error instanceof ExplorerHandoffError) {
        throw error;
      }
      throw new ExplorerHandoffError(
        "EXPLORER_HANDOFF_FAILED",
        "Explorer stable target handoff failed atomically",
        error
      );
    }
  }
}
