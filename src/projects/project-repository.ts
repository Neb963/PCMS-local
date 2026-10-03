import type { DatabaseSync } from "node:sqlite";

const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_GENERATOR_LOCAL_ID =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface ProjectRecord {
  readonly projectId: string;
  readonly generatorLocalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface CreateProjectInput {
  readonly projectId: string;
  readonly generatorLocalId: string;
}

export interface ProjectRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export type ProjectRepositoryErrorCode =
  | "PROJECT_ID_INVALID"
  | "PROJECT_GENERATOR_ID_INVALID"
  | "PROJECT_EXISTS"
  | "PROJECT_GENERATOR_CONFLICT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ROW_INVALID";

export class ProjectRepositoryError extends Error {
  public constructor(
    public readonly code: ProjectRepositoryErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectRepositoryError";
  }
}

interface ProjectRow {
  readonly project_id: unknown;
  readonly generator_local_id: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

function validateProjectId(projectId: string): void {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new ProjectRepositoryError(
      "PROJECT_ID_INVALID",
      "Project ID must be a safe opaque identifier"
    );
  }
}

function validateGeneratorLocalId(
  generatorLocalId: string
): void {
  if (!SAFE_GENERATOR_LOCAL_ID.test(generatorLocalId)) {
    throw new ProjectRepositoryError(
      "PROJECT_GENERATOR_ID_INVALID",
      "Project Generator local ID must be a safe opaque identifier"
    );
  }
}

function parseProject(
  row: ProjectRow | undefined
): ProjectRecord | null {
  if (row === undefined) return null;
  if (
    typeof row.project_id !== "string" ||
    typeof row.generator_local_id !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    throw new ProjectRepositoryError(
      "PROJECT_ROW_INVALID",
      "Stored Project target metadata is invalid"
    );
  }
  return Object.freeze({
    projectId: row.project_id,
    generatorLocalId: row.generator_local_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision
  });
}

export class ProjectRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(options: ProjectRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  public create(input: CreateProjectInput): ProjectRecord {
    validateProjectId(input.projectId);
    validateGeneratorLocalId(input.generatorLocalId);
    const now = this.#now().toISOString();

    try {
      this.#database.prepare(`
        INSERT INTO projects (
          project_id,
          generator_local_id,
          created_at,
          updated_at,
          revision
        ) VALUES (?, ?, ?, ?, 0)
      `).run(
        input.projectId,
        input.generatorLocalId,
        now,
        now
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: projects.project_id"
        )
      ) {
        throw new ProjectRepositoryError(
          "PROJECT_EXISTS",
          `Project ${input.projectId} already exists`,
          error
        );
      }
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: projects.generator_local_id"
        )
      ) {
        throw new ProjectRepositoryError(
          "PROJECT_GENERATOR_CONFLICT",
          `Generator ${input.generatorLocalId} is already linked to another Project`,
          error
        );
      }
      throw error;
    }

    return this.require(input.projectId);
  }

  public get(projectId: string): ProjectRecord | null {
    validateProjectId(projectId);
    const row = this.#database.prepare(`
      SELECT
        project_id,
        generator_local_id,
        created_at,
        updated_at,
        revision
      FROM projects
      WHERE project_id = ?
    `).get(projectId) as unknown as ProjectRow | undefined;
    return parseProject(row);
  }

  public require(projectId: string): ProjectRecord {
    const project = this.get(projectId);
    if (project === null) {
      throw new ProjectRepositoryError(
        "PROJECT_NOT_FOUND",
        `Project ${projectId} does not exist`
      );
    }
    return project;
  }

  public list(): readonly ProjectRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        project_id,
        generator_local_id,
        created_at,
        updated_at,
        revision
      FROM projects
      ORDER BY project_id
    `).all() as unknown as ProjectRow[];
    return Object.freeze(rows.map((row) => {
      const project = parseProject(row);
      if (project === null) {
        throw new ProjectRepositoryError(
          "PROJECT_ROW_INVALID",
          "Stored Project target unexpectedly disappeared"
        );
      }
      return project;
    }));
  }
}
