import type { DatabaseSync } from "node:sqlite";

import {
  moduleAuthorityEnvelopeFromManifest,
  type ModuleAuthorityEnvelope
} from "./authority.js";
import {
  ModuleActivationStore,
  type ModuleCandidateAuthority
} from "./activation-store.js";
import {
  ModuleLifecycleStore
} from "./lifecycle-store.js";
import {
  ModulePackageStore,
  type InstalledModulePackage
} from "./package-store.js";
import {
  startModuleRuntime,
  type ModuleRuntime,
  type ModuleSdkHandler
} from "./runner.js";
import {
  ModuleStateStore,
  createModuleStorageSdkHandlers,
  type ModuleRegistration
} from "./state-store.js";
import {
  ModuleUiHost,
  type ModuleUiSession
} from "./ui-host.js";

export interface ModuleManagerOptions {
  readonly packageRoot: string;
  readonly now?: () => Date;
}

export interface InstalledModuleResult {
  readonly package: InstalledModulePackage;
  readonly registration: ModuleRegistration;
}

export interface ModuleUpdateResult {
  readonly package: InstalledModulePackage;
  readonly candidateAuthority: ModuleCandidateAuthority;
  readonly stateGeneration: number;
  readonly status: "ACTIVE" | "AWAITING_APPROVAL";
  readonly registration: ModuleRegistration;
}

export interface StartActiveModuleOptions {
  readonly sdkHandlers?: Readonly<
    Record<string, ModuleSdkHandler>
  >;
}

export interface MountActiveModuleUiOptions {
  readonly sdkHandlers?: Readonly<
    Record<string, ModuleSdkHandler>
  >;
}

export class ModuleManagerError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleManagerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new ModuleManagerError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause }
  );
}

function mergedSdkHandlers(
  storage: Readonly<Record<string, ModuleSdkHandler>>,
  extra: Readonly<Record<string, ModuleSdkHandler>> | undefined
): Readonly<Record<string, ModuleSdkHandler>> {
  return Object.freeze({
    ...extra,
    ...storage
  });
}

export class ModuleManager {
  readonly #state: ModuleStateStore;
  readonly #activation: ModuleActivationStore;
  readonly #lifecycle: ModuleLifecycleStore;
  readonly #packages: ModulePackageStore;

  public constructor(
    database: DatabaseSync,
    options: ModuleManagerOptions
  ) {
    const storeOptions =
      options.now === undefined
        ? {}
        : { now: options.now };
    this.#state = new ModuleStateStore(
      database,
      storeOptions
    );
    this.#activation = new ModuleActivationStore(
      database,
      storeOptions
    );
    this.#lifecycle = new ModuleLifecycleStore(
      database,
      storeOptions
    );
    this.#packages = new ModulePackageStore(
      options.packageRoot
    );
  }

  public get stateStore(): ModuleStateStore {
    return this.#state;
  }

  public get activationStore(): ModuleActivationStore {
    return this.#activation;
  }

  public get lifecycleStore(): ModuleLifecycleStore {
    return this.#lifecycle;
  }

  public get packageStore(): ModulePackageStore {
    return this.#packages;
  }

  public async installPackage(
    input: Uint8Array
  ): Promise<InstalledModuleResult> {
    const installed = await this.#packages.install(input);
    const healthy = await this.#probePackage(
      installed,
      1
    );
    if (!healthy) {
      fail(
        "MODULE_PACKAGE_HEALTH_FAILED",
        "module package backend failed pre-activation startup"
      );
    }
    const authority =
      moduleAuthorityEnvelopeFromManifest(
        installed.manifest
      );
    const registration = this.#state.registerModule(
      installed.moduleId,
      installed.version,
      installed.manifest.stateSchemaVersion,
      {},
      authority
    );
    return Object.freeze({
      package: installed,
      registration
    });
  }

  public async updatePackage(
    input: Uint8Array
  ): Promise<ModuleUpdateResult> {
    const installed = await this.#packages.install(input);
    const current = this.#state.readActiveState(
      installed.moduleId
    );
    if (
      current.registration.activeVersion ===
      installed.version
    ) {
      fail(
        "MODULE_VERSION_ALREADY_ACTIVE",
        `module version is already active: ${installed.moduleId}@${installed.version}`
      );
    }
    if (
      current.registration.stateSchemaVersion !==
      installed.manifest.stateSchemaVersion
    ) {
      fail(
        "MODULE_STATE_MIGRATION_UNAVAILABLE",
        "package update changes module state schema without an executable migration contract"
      );
    }

    if (
      current.registration.runtimeGeneration >=
      Number.MAX_SAFE_INTEGER
    ) {
      fail(
        "MODULE_RUNTIME_GENERATION_EXHAUSTED",
        "module runtime generation is exhausted"
      );
    }
    const candidateRuntimeGeneration =
      current.registration.runtimeGeneration + 1;
    const candidate = await this.#state.prepareCandidateState({
      moduleId: installed.moduleId,
      version: installed.version,
      stateSchemaVersion:
        installed.manifest.stateSchemaVersion,
      migrate: ({ state }) => ({ ...state }),
      healthCheck: () =>
        this.#probePackage(
          installed,
          candidateRuntimeGeneration
        )
    });
    const authority =
      this.#activation.stageCandidateAuthority(
        installed.moduleId,
        candidate.stateGeneration,
        moduleAuthorityEnvelopeFromManifest(
          installed.manifest
        )
      );

    if (
      authority.approvalStatus ===
      "AWAITING_APPROVAL"
    ) {
      return Object.freeze({
        package: installed,
        candidateAuthority: authority,
        stateGeneration: candidate.stateGeneration,
        status: "AWAITING_APPROVAL",
        registration: current.registration
      });
    }

    this.#activation.activateReadyCandidate(
      installed.moduleId,
      candidate.stateGeneration
    );
    return Object.freeze({
      package: installed,
      candidateAuthority: authority,
      stateGeneration: candidate.stateGeneration,
      status: "ACTIVE",
      registration: this.#state.getRegistration(
        installed.moduleId
      )
    });
  }

  public async approveAndActivateUpdate(
    moduleId: string,
    stateGeneration: number
  ): Promise<ModuleUpdateResult> {
    const authority =
      this.#activation.approveCandidateAuthority(
        moduleId,
        stateGeneration
      );
    const candidate =
      this.#state.getReadyCandidate(moduleId);
    if (
      candidate === null ||
      candidate.stateGeneration !== stateGeneration
    ) {
      fail(
        "MODULE_CANDIDATE_NOT_READY",
        "approved module candidate is no longer ready"
      );
    }
    const installed =
      await this.#packages.getInstalled(
        moduleId,
        candidate.version
      );
    this.#activation.activateReadyCandidate(
      moduleId,
      stateGeneration
    );
    return Object.freeze({
      package: installed,
      candidateAuthority: authority,
      stateGeneration,
      status: "ACTIVE",
      registration: this.#state.getRegistration(moduleId)
    });
  }

  public async startActiveRuntime(
    moduleId: string,
    options: StartActiveModuleOptions = {}
  ): Promise<ModuleRuntime> {
    const registration =
      this.#state.getRegistration(moduleId);
    this.#state.assertRuntimeCurrent(
      moduleId,
      registration.runtimeGeneration
    );
    const installed =
      await this.#packages.getInstalled(
        moduleId,
        registration.activeVersion
      );
    const storageHandlers =
      createModuleStorageSdkHandlers(
        this.#state,
        moduleId,
        registration.runtimeGeneration
      );
    return startModuleRuntime({
      moduleId,
      version: registration.activeVersion,
      packageRoot: installed.packageRoot,
      backendEntry: installed.backendEntry,
      runtimeGeneration:
        registration.runtimeGeneration,
      sdkHandlers: mergedSdkHandlers(
        storageHandlers,
        options.sdkHandlers
      ),
      authorizeSdkRequest: (context) => {
        this.#state.assertRuntimeCurrent(
          context.moduleId,
          context.runtimeGeneration
        );
      }
    });
  }

  async #probePackage(
    installed: InstalledModulePackage,
    runtimeGeneration: number
  ): Promise<boolean> {
    let runtime: ModuleRuntime | null = null;
    try {
      runtime = await startModuleRuntime({
        moduleId: installed.moduleId,
        version: installed.version,
        packageRoot: installed.packageRoot,
        backendEntry: installed.backendEntry,
        runtimeGeneration,
        sdkHandlers: {},
        authorizeSdkRequest: () => {
          throw new ModuleManagerError(
            "MODULE_CANDIDATE_SDK_UNAVAILABLE",
            "candidate startup health probe cannot mutate Core through the module SDK"
          );
        }
      });
      return true;
    } catch {
      return false;
    } finally {
      if (runtime !== null) {
        await runtime.stop().catch(() => undefined);
      }
    }
  }

  public async mountActiveUi(
    moduleId: string,
    host: ModuleUiHost,
    options: MountActiveModuleUiOptions = {}
  ): Promise<ModuleUiSession> {
    const registration =
      this.#state.getRegistration(moduleId);
    this.#state.assertRuntimeCurrent(
      moduleId,
      registration.runtimeGeneration
    );
    const installed =
      await this.#packages.getInstalled(
        moduleId,
        registration.activeVersion
      );
    if (installed.uiEntry === undefined) {
      fail(
        "MODULE_UI_NOT_DECLARED",
        "active module package does not declare a UI"
      );
    }
    const authority: ModuleAuthorityEnvelope =
      this.#activation.getApprovedAuthority(moduleId);
    const storageHandlers =
      createModuleStorageSdkHandlers(
        this.#state,
        moduleId,
        registration.runtimeGeneration
      );
    return host.mount({
      package: {
        moduleId: installed.moduleId,
        version: installed.version,
        uiEntry: installed.uiEntry,
        readFile: (path) => installed.readFile(path)
      },
      runtimeGeneration:
        registration.runtimeGeneration,
      approvedAuthority: authority,
      sdkHandlers: mergedSdkHandlers(
        storageHandlers,
        options.sdkHandlers
      ),
      authorizeSdkRequest: (context) => {
        this.#state.assertRuntimeCurrent(
          context.moduleId,
          context.runtimeGeneration
        );
      }
    });
  }
}
