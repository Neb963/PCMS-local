import type { DatabaseSync } from "node:sqlite";

import type { ModuleSdkHandler } from "./runner.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const MODULE_STATE_MAX_ENTRIES = 512;
export const MODULE_STATE_MAX_VALUE_BYTES = 32 * 1024;
export const MODULE_STATE_MAX_TOTAL_BYTES = 512 * 1024;
export const MODULE_CANDIDATE_STEP_TIMEOUT_MS = 2_000;

export type ModuleJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ModuleJsonValue[]
  | Readonly<{ [key: string]: ModuleJsonValue }>;

export type ModuleStateSnapshot = Readonly<Record<string, ModuleJsonValue>>;

export interface ModuleRegistration {
  readonly moduleId: string;
  readonly activeVersion: string;
  readonly activeStateGeneration: number;
  readonly runtimeGeneration: number;
  readonly runtimeEnabled: boolean;
  readonly stateSchemaVersion: number;
  readonly stateRevision: number;
  readonly updatedAt: string;
}

export interface ModuleActiveState {
  readonly registration: ModuleRegistration;
  readonly state: ModuleStateSnapshot;
}

export interface ModuleCandidateState {
  readonly moduleId: string;
  readonly version: string;
  readonly stateGeneration: number;
  readonly stateSchemaVersion: number;
  readonly baseStateGeneration: number;
  readonly baseStateRevision: number;
  readonly status: "READY_TO_SWITCH";
  readonly state: ModuleStateSnapshot;
  readonly createdAt: string;
}

export interface ModuleMigrationContext {
  readonly moduleId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  readonly state: ModuleStateSnapshot;
}

export interface ModuleCandidateHealthContext {
  readonly moduleId: string;
  readonly version: string;
  readonly stateSchemaVersion: number;
  readonly state: ModuleStateSnapshot;
}

export interface PrepareModuleCandidateOptions {
  readonly moduleId: string;
  readonly version: string;
  readonly stateSchemaVersion: number;
  readonly migrate?: (
    context: ModuleMigrationContext
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly healthCheck: (
    context: ModuleCandidateHealthContext
  ) => boolean | Promise<boolean>;
  readonly timeoutMs?: number;
}

export interface ModuleStateStoreOptions {
  readonly now?: () => Date;
}

export class ModuleStateError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleStateError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface RegistrationRow {
  readonly module_id: string;
  readonly active_version: string;
  readonly active_state_generation: number;
  readonly runtime_generation: number;
  readonly runtime_enabled: number;
  readonly state_schema_version: number;
  readonly state_revision: number;
  readonly updated_at: string;
}

interface GenerationRow {
  readonly module_id: string;
  readonly state_generation: number;
  readonly module_version: string;
  readonly schema_version: number;
  readonly status: string;
  readonly base_state_generation: number | null;
  readonly base_state_revision: number | null;
  readonly created_at: string;
}

interface NormalizedState {
  readonly state: ModuleStateSnapshot;
  readonly entries: readonly Readonly<{
    key: string;
    json: string;
  }>[];
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ModuleStateError(
    code,
    message,
    false,
    cause === undefined ? undefined : { cause }
  );
}

function validateModuleId(moduleId: string): void {
  if (moduleId.length > 64 || !MODULE_ID.test(moduleId)) {
    fail("INVALID_MODULE_STATE", "moduleId has invalid syntax");
  }
}

function validateVersion(version: string): void {
  if (version.length > 128 || !SEMVER.test(version)) {
    fail(
      "INVALID_MODULE_STATE",
      "module version must use semantic version syntax"
    );
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_MODULE_STATE", `${label} must be a positive safe integer`);
  }
}

function validateStateKey(key: string): void {
  if (!STATE_KEY.test(key)) {
    fail("INVALID_MODULE_STATE", `invalid module state key: ${key}`);
  }
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>
): ModuleJsonValue {
  if (depth > 32) {
    fail(
      "INVALID_MODULE_STATE",
      `module state exceeds nesting limit at ${path}`
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "INVALID_MODULE_STATE",
        `module state contains non-finite number at ${path}`
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      fail("INVALID_MODULE_STATE", `module state contains a cycle at ${path}`);
    }
    seen.add(value);
    const normalized = value.map((item, index) =>
      normalizeJsonValue(item, `${path}[${index}]`, depth + 1, seen)
    );
    seen.delete(value);
    return Object.freeze(normalized);
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(
        "INVALID_MODULE_STATE",
        `module state must use plain objects at ${path}`
      );
    }
    if (seen.has(value)) {
      fail("INVALID_MODULE_STATE", `module state contains a cycle at ${path}`);
    }
    seen.add(value);
    const normalized: Record<string, ModuleJsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        depth + 1,
        seen
      );
    }
    seen.delete(value);
    return Object.freeze(normalized);
  }
  fail(
    "INVALID_MODULE_STATE",
    `module state contains unsupported value at ${path}`
  );
}

function normalizeState(
  state: Readonly<Record<string, unknown>>
): NormalizedState {
  if (
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state)
  ) {
    fail("INVALID_MODULE_STATE", "module state must be an object");
  }

  const keys = Object.keys(state).sort();
  if (keys.length > MODULE_STATE_MAX_ENTRIES) {
    fail(
      "MODULE_STATE_LIMIT_EXCEEDED",
      `module state exceeds ${MODULE_STATE_MAX_ENTRIES} entries`
    );
  }

  const normalized: Record<string, ModuleJsonValue> = {};
  const entries: Array<Readonly<{ key: string; json: string }>> = [];
  let totalBytes = 0;

  for (const key of keys) {
    validateStateKey(key);
    const value = normalizeJsonValue(
      state[key],
      `state.${key}`,
      0,
      new Set()
    );
    const json = JSON.stringify(value);
    const valueBytes = Buffer.byteLength(json);
    if (valueBytes > MODULE_STATE_MAX_VALUE_BYTES) {
      fail(
        "MODULE_STATE_LIMIT_EXCEEDED",
        `module state value exceeds ${MODULE_STATE_MAX_VALUE_BYTES} bytes: ${key}`
      );
    }
    totalBytes += Buffer.byteLength(key) + valueBytes;
    if (totalBytes > MODULE_STATE_MAX_TOTAL_BYTES) {
      fail(
        "MODULE_STATE_LIMIT_EXCEEDED",
        `module state exceeds ${MODULE_STATE_MAX_TOTAL_BYTES} total bytes`
      );
    }
    normalized[key] = value;
    entries.push(Object.freeze({ key, json }));
  }

  return Object.freeze({
    state: Object.freeze(normalized),
    entries: Object.freeze(entries)
  });
}

function parseStoredJson(json: string, key: string): ModuleJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    fail(
      "MODULE_STATE_CORRUPT",
      `stored module state is invalid JSON: ${key}`,
      error
    );
  }
  return normalizeJsonValue(parsed, `state.${key}`, 0, new Set());
}

function parseRegistrationRow(
  row: Record<string, unknown> | undefined
): ModuleRegistration {
  if (row === undefined) {
    fail("MODULE_NOT_REGISTERED", "module is not registered");
  }

  const candidate = row as unknown as RegistrationRow;
  if (
    typeof candidate.module_id !== "string" ||
    typeof candidate.active_version !== "string" ||
    typeof candidate.active_state_generation !== "number" ||
    !Number.isSafeInteger(candidate.active_state_generation) ||
    typeof candidate.runtime_generation !== "number" ||
    !Number.isSafeInteger(candidate.runtime_generation) ||
    (candidate.runtime_enabled !== 0 && candidate.runtime_enabled !== 1) ||
    typeof candidate.state_schema_version !== "number" ||
    !Number.isSafeInteger(candidate.state_schema_version) ||
    typeof candidate.state_revision !== "number" ||
    !Number.isSafeInteger(candidate.state_revision) ||
    typeof candidate.updated_at !== "string"
  ) {
    fail(
      "MODULE_STATE_CORRUPT",
      "module registry contains invalid metadata"
    );
  }

  return Object.freeze({
    moduleId: candidate.module_id,
    activeVersion: candidate.active_version,
    activeStateGeneration: candidate.active_state_generation,
    runtimeGeneration: candidate.runtime_generation,
    runtimeEnabled: candidate.runtime_enabled === 1,
    stateSchemaVersion: candidate.state_schema_version,
    stateRevision: candidate.state_revision,
    updatedAt: candidate.updated_at
  });
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    fail(
      "INVALID_MODULE_STATE",
      "candidate step timeout must be between 1 and 30000 ms"
    );
  }
}

async function runBoundedCandidateStep<T>(
  label: "migration" | "health check",
  code:
    | "MODULE_CANDIDATE_MIGRATION_FAILED"
    | "MODULE_CANDIDATE_HEALTH_FAILED",
  timeoutMs: number,
  operation: () => T | Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ModuleStateError(
              code,
              `module candidate ${label} timed out after ${timeoutMs} ms`
            )
          );
        }, timeoutMs);
      })
    ]);
  } catch (error: unknown) {
    if (error instanceof ModuleStateError && error.code === code) {
      throw error;
    }
    throw new ModuleStateError(
      code,
      `module candidate ${label} failed`,
      false,
      error instanceof Error ? { cause: error } : undefined
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireParams(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(
      "INVALID_MODULE_SDK_PARAMS",
      `${label} params must be an object`
    );
  }

  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      fail(
        "INVALID_MODULE_SDK_PARAMS",
        `${label} params contain unknown field: ${key}`
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      fail(
        "INVALID_MODULE_SDK_PARAMS",
        `${label} params are missing field: ${key}`
      );
    }
  }
  return record;
}

export class ModuleStateStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(
    database: DatabaseSync,
    options: ModuleStateStoreOptions = {}
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  public registerModule(
    moduleId: string,
    version: string,
    stateSchemaVersion: number,
    initialState: Readonly<Record<string, unknown>> = {}
  ): ModuleRegistration {
    validateModuleId(moduleId);
    validateVersion(version);
    validatePositiveInteger(stateSchemaVersion, "stateSchemaVersion");
    const normalized = normalizeState(initialState);
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const existing = this.#database
        .prepare(
          "SELECT module_id FROM module_registry WHERE module_id = ?"
        )
        .get(moduleId);
      if (existing !== undefined) {
        fail(
          "MODULE_ALREADY_REGISTERED",
          `module is already registered: ${moduleId}`
        );
      }

      this.#database.prepare(`
        INSERT INTO module_state_generations (
          module_id,
          state_generation,
          module_version,
          schema_version,
          status,
          base_state_generation,
          base_state_revision,
          created_at
        ) VALUES (?, 1, ?, ?, 'ACTIVE', NULL, NULL, ?)
      `).run(moduleId, version, stateSchemaVersion, now);

      const insertEntry = this.#database.prepare(`
        INSERT INTO module_state_entries (
          module_id,
          state_generation,
          state_key,
          value_json
        ) VALUES (?, 1, ?, ?)
      `);
      for (const entry of normalized.entries) {
        insertEntry.run(moduleId, entry.key, entry.json);
      }

      this.#database.prepare(`
        INSERT INTO module_registry (
          module_id,
          active_version,
          active_state_generation,
          runtime_generation,
          runtime_enabled,
          state_schema_version,
          state_revision,
          updated_at
        ) VALUES (?, ?, 1, 1, 1, ?, 0, ?)
      `).run(moduleId, version, stateSchemaVersion, now);

      return this.getRegistration(moduleId);
    });
  }

  public getRegistration(moduleId: string): ModuleRegistration {
    validateModuleId(moduleId);
    const row = this.#database.prepare(`
      SELECT
        module_id,
        active_version,
        active_state_generation,
        runtime_generation,
        runtime_enabled,
        state_schema_version,
        state_revision,
        updated_at
      FROM module_registry
      WHERE module_id = ?
    `).get(moduleId);
    return parseRegistrationRow(row);
  }

  public readActiveState(moduleId: string): ModuleActiveState {
    const registration = this.getRegistration(moduleId);
    return Object.freeze({
      registration,
      state: this.#readGenerationState(
        moduleId,
        registration.activeStateGeneration
      )
    });
  }

  public assertRuntimeCurrent(
    moduleId: string,
    runtimeGeneration: number
  ): ModuleRegistration {
    validatePositiveInteger(runtimeGeneration, "runtimeGeneration");
    const registration = this.getRegistration(moduleId);
    if (registration.runtimeGeneration !== runtimeGeneration) {
      throw new ModuleStateError(
        "MODULE_RUNTIME_STALE",
        `module runtime generation ${runtimeGeneration} is stale; current generation is ${registration.runtimeGeneration}`
      );
    }
    if (!registration.runtimeEnabled) {
      throw new ModuleStateError(
        "MODULE_RUNTIME_DISABLED",
        "module runtime is disabled"
      );
    }
    return registration;
  }

  public advanceRuntimeGeneration(
    moduleId: string,
    expectedRuntimeGeneration: number,
    enabled: boolean
  ): ModuleRegistration {
    validateModuleId(moduleId);
    validatePositiveInteger(
      expectedRuntimeGeneration,
      "expectedRuntimeGeneration"
    );
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const current = this.getRegistration(moduleId);
      if (current.runtimeGeneration !== expectedRuntimeGeneration) {
        throw new ModuleStateError(
          "MODULE_RUNTIME_STALE",
          `cannot fence generation ${expectedRuntimeGeneration}; current generation is ${current.runtimeGeneration}`
        );
      }
      if (current.runtimeGeneration === Number.MAX_SAFE_INTEGER) {
        fail(
          "MODULE_RUNTIME_GENERATION_EXHAUSTED",
          "module runtime generation is exhausted"
        );
      }

      this.#database.prepare(`
        UPDATE module_registry
        SET runtime_generation = runtime_generation + 1,
            runtime_enabled = ?,
            updated_at = ?
        WHERE module_id = ? AND runtime_generation = ?
      `).run(
        enabled ? 1 : 0,
        now,
        moduleId,
        expectedRuntimeGeneration
      );
      return this.getRegistration(moduleId);
    });
  }

  public getActiveValue(
    moduleId: string,
    runtimeGeneration: number,
    key: string
  ): Readonly<{ found: boolean; value?: ModuleJsonValue }> {
    validateStateKey(key);
    const registration = this.assertRuntimeCurrent(
      moduleId,
      runtimeGeneration
    );
    const row = this.#database.prepare(`
      SELECT value_json
      FROM module_state_entries
      WHERE module_id = ?
        AND state_generation = ?
        AND state_key = ?
    `).get(moduleId, registration.activeStateGeneration, key);

    if (row === undefined) return Object.freeze({ found: false });

    const json = row["value_json"];
    if (typeof json !== "string") {
      fail(
        "MODULE_STATE_CORRUPT",
        `stored module state is invalid: ${key}`
      );
    }
    return Object.freeze({
      found: true,
      value: parseStoredJson(json, key)
    });
  }

  public setActiveValue(
    moduleId: string,
    runtimeGeneration: number,
    key: string,
    value: unknown
  ): ModuleRegistration {
    validateStateKey(key);
    const normalized = normalizeState({ [key]: value });
    const entry = normalized.entries[0];
    if (entry === undefined) {
      fail("INVALID_MODULE_STATE", "module state value is missing");
    }
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const registration = this.assertRuntimeCurrent(
        moduleId,
        runtimeGeneration
      );
      this.#database.prepare(`
        INSERT INTO module_state_entries (
          module_id,
          state_generation,
          state_key,
          value_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(module_id, state_generation, state_key)
        DO UPDATE SET value_json = excluded.value_json
      `).run(
        moduleId,
        registration.activeStateGeneration,
        key,
        entry.json
      );
      this.#database.prepare(`
        UPDATE module_registry
        SET state_revision = state_revision + 1,
            updated_at = ?
        WHERE module_id = ? AND runtime_generation = ?
      `).run(now, moduleId, runtimeGeneration);
      return this.getRegistration(moduleId);
    });
  }

  public deleteActiveValue(
    moduleId: string,
    runtimeGeneration: number,
    key: string
  ): ModuleRegistration {
    validateStateKey(key);
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const registration = this.assertRuntimeCurrent(
        moduleId,
        runtimeGeneration
      );
      this.#database.prepare(`
        DELETE FROM module_state_entries
        WHERE module_id = ?
          AND state_generation = ?
          AND state_key = ?
      `).run(moduleId, registration.activeStateGeneration, key);
      this.#database.prepare(`
        UPDATE module_registry
        SET state_revision = state_revision + 1,
            updated_at = ?
        WHERE module_id = ? AND runtime_generation = ?
      `).run(now, moduleId, runtimeGeneration);
      return this.getRegistration(moduleId);
    });
  }

  public async prepareCandidateState(
    options: PrepareModuleCandidateOptions
  ): Promise<ModuleCandidateState> {
    validateModuleId(options.moduleId);
    validateVersion(options.version);
    validatePositiveInteger(
      options.stateSchemaVersion,
      "stateSchemaVersion"
    );
    const timeoutMs =
      options.timeoutMs ?? MODULE_CANDIDATE_STEP_TIMEOUT_MS;
    validateTimeout(timeoutMs);

    const active = this.readActiveState(options.moduleId);
    const migrationContext: ModuleMigrationContext = Object.freeze({
      moduleId: options.moduleId,
      fromVersion: active.registration.activeVersion,
      toVersion: options.version,
      fromSchemaVersion: active.registration.stateSchemaVersion,
      toSchemaVersion: options.stateSchemaVersion,
      state: active.state
    });

    const migratedInput =
      options.migrate === undefined
        ? active.state
        : await runBoundedCandidateStep(
            "migration",
            "MODULE_CANDIDATE_MIGRATION_FAILED",
            timeoutMs,
            () => options.migrate?.(migrationContext) ?? active.state
          );

    let migrated: NormalizedState;
    try {
      migrated = normalizeState(migratedInput);
    } catch (error: unknown) {
      throw new ModuleStateError(
        "MODULE_CANDIDATE_MIGRATION_FAILED",
        "module candidate migration produced invalid or oversized state",
        false,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    const healthContext: ModuleCandidateHealthContext = Object.freeze({
      moduleId: options.moduleId,
      version: options.version,
      stateSchemaVersion: options.stateSchemaVersion,
      state: migrated.state
    });
    const healthy = await runBoundedCandidateStep(
      "health check",
      "MODULE_CANDIDATE_HEALTH_FAILED",
      timeoutMs,
      () => options.healthCheck(healthContext)
    );
    if (healthy !== true) {
      throw new ModuleStateError(
        "MODULE_CANDIDATE_HEALTH_FAILED",
        "module candidate health check did not pass"
      );
    }

    const createdAt = this.#now().toISOString();
    const generation = transaction(this.#database, () => {
      const current = this.getRegistration(options.moduleId);
      if (
        current.activeVersion !==
          active.registration.activeVersion ||
        current.activeStateGeneration !==
          active.registration.activeStateGeneration ||
        current.stateRevision !==
          active.registration.stateRevision
      ) {
        throw new ModuleStateError(
          "MODULE_ACTIVE_STATE_CHANGED",
          "active module state changed while candidate migration was running",
          true
        );
      }

      const existing = this.#database.prepare(`
        SELECT state_generation
        FROM module_state_generations
        WHERE module_id = ?
          AND status = 'READY_TO_SWITCH'
      `).get(options.moduleId);
      if (existing !== undefined) {
        throw new ModuleStateError(
          "MODULE_CANDIDATE_EXISTS",
          "module already has a candidate ready to switch"
        );
      }

      const row = this.#database.prepare(`
        SELECT COALESCE(MAX(state_generation), 0) AS max_generation
        FROM module_state_generations
        WHERE module_id = ?
      `).get(options.moduleId);
      const maxGeneration = row?.["max_generation"];
      if (
        typeof maxGeneration !== "number" ||
        !Number.isSafeInteger(maxGeneration) ||
        maxGeneration >= Number.MAX_SAFE_INTEGER
      ) {
        fail(
          "MODULE_STATE_CORRUPT",
          "module state generation metadata is invalid"
        );
      }
      const nextGeneration = maxGeneration + 1;

      this.#database.prepare(`
        INSERT INTO module_state_generations (
          module_id,
          state_generation,
          module_version,
          schema_version,
          status,
          base_state_generation,
          base_state_revision,
          created_at
        ) VALUES (?, ?, ?, ?, 'READY_TO_SWITCH', ?, ?, ?)
      `).run(
        options.moduleId,
        nextGeneration,
        options.version,
        options.stateSchemaVersion,
        active.registration.activeStateGeneration,
        active.registration.stateRevision,
        createdAt
      );

      const insertEntry = this.#database.prepare(`
        INSERT INTO module_state_entries (
          module_id,
          state_generation,
          state_key,
          value_json
        ) VALUES (?, ?, ?, ?)
      `);
      for (const entry of migrated.entries) {
        insertEntry.run(
          options.moduleId,
          nextGeneration,
          entry.key,
          entry.json
        );
      }

      return nextGeneration;
    });

    return Object.freeze({
      moduleId: options.moduleId,
      version: options.version,
      stateGeneration: generation,
      stateSchemaVersion: options.stateSchemaVersion,
      baseStateGeneration:
        active.registration.activeStateGeneration,
      baseStateRevision: active.registration.stateRevision,
      status: "READY_TO_SWITCH",
      state: migrated.state,
      createdAt
    });
  }

  public getReadyCandidate(
    moduleId: string
  ): ModuleCandidateState | null {
    validateModuleId(moduleId);
    const row = this.#database.prepare(`
      SELECT
        module_id,
        state_generation,
        module_version,
        schema_version,
        status,
        base_state_generation,
        base_state_revision,
        created_at
      FROM module_state_generations
      WHERE module_id = ?
        AND status = 'READY_TO_SWITCH'
    `).get(moduleId);

    if (row === undefined) return null;

    const candidate = row as unknown as GenerationRow;
    if (
      candidate.module_id !== moduleId ||
      typeof candidate.state_generation !== "number" ||
      !Number.isSafeInteger(candidate.state_generation) ||
      typeof candidate.module_version !== "string" ||
      typeof candidate.schema_version !== "number" ||
      !Number.isSafeInteger(candidate.schema_version) ||
      candidate.status !== "READY_TO_SWITCH" ||
      typeof candidate.base_state_generation !== "number" ||
      !Number.isSafeInteger(candidate.base_state_generation) ||
      typeof candidate.base_state_revision !== "number" ||
      !Number.isSafeInteger(candidate.base_state_revision) ||
      typeof candidate.created_at !== "string"
    ) {
      fail(
        "MODULE_STATE_CORRUPT",
        "module candidate metadata is invalid"
      );
    }

    return Object.freeze({
      moduleId,
      version: candidate.module_version,
      stateGeneration: candidate.state_generation,
      stateSchemaVersion: candidate.schema_version,
      baseStateGeneration: candidate.base_state_generation,
      baseStateRevision: candidate.base_state_revision,
      status: "READY_TO_SWITCH",
      state: this.#readGenerationState(
        moduleId,
        candidate.state_generation
      ),
      createdAt: candidate.created_at
    });
  }

  public discardReadyCandidate(moduleId: string): void {
    validateModuleId(moduleId);
    transaction(this.#database, () => {
      this.#database.prepare(`
        DELETE FROM module_state_generations
        WHERE module_id = ?
          AND status = 'READY_TO_SWITCH'
      `).run(moduleId);
    });
  }

  #readGenerationState(
    moduleId: string,
    stateGeneration: number
  ): ModuleStateSnapshot {
    const rows = this.#database.prepare(`
      SELECT state_key, value_json
      FROM module_state_entries
      WHERE module_id = ?
        AND state_generation = ?
      ORDER BY state_key
    `).all(moduleId, stateGeneration);

    const state: Record<string, ModuleJsonValue> = {};
    for (const row of rows) {
      const key = row["state_key"];
      const json = row["value_json"];
      if (typeof key !== "string" || typeof json !== "string") {
        fail(
          "MODULE_STATE_CORRUPT",
          "module state row contains invalid metadata"
        );
      }
      validateStateKey(key);
      state[key] = parseStoredJson(json, key);
    }

    return Object.freeze(state);
  }
}

export function createModuleStorageSdkHandlers(
  store: ModuleStateStore,
  moduleId: string,
  runtimeGeneration: number
): Readonly<Record<string, ModuleSdkHandler>> {
  validateModuleId(moduleId);
  validatePositiveInteger(
    runtimeGeneration,
    "runtimeGeneration"
  );

  return Object.freeze({
    "storage.get": (params: unknown) => {
      const record = requireParams(
        params,
        ["key"],
        "storage.get"
      );
      const key = record["key"];
      if (typeof key !== "string") {
        fail(
          "INVALID_MODULE_SDK_PARAMS",
          "storage.get key must be a string"
        );
      }
      return store.getActiveValue(
        moduleId,
        runtimeGeneration,
        key
      );
    },
    "storage.set": (params: unknown) => {
      const record = requireParams(
        params,
        ["key", "value"],
        "storage.set"
      );
      const key = record["key"];
      if (typeof key !== "string") {
        fail(
          "INVALID_MODULE_SDK_PARAMS",
          "storage.set key must be a string"
        );
      }
      const registration = store.setActiveValue(
        moduleId,
        runtimeGeneration,
        key,
        record["value"]
      );
      return Object.freeze({
        stateRevision: registration.stateRevision
      });
    },
    "storage.delete": (params: unknown) => {
      const record = requireParams(
        params,
        ["key"],
        "storage.delete"
      );
      const key = record["key"];
      if (typeof key !== "string") {
        fail(
          "INVALID_MODULE_SDK_PARAMS",
          "storage.delete key must be a string"
        );
      }
      const registration = store.deleteActiveValue(
        moduleId,
        runtimeGeneration,
        key
      );
      return Object.freeze({
        stateRevision: registration.stateRevision
      });
    }
  });
}
