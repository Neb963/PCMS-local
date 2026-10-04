import type { DatabaseSync } from "node:sqlite";

import {
  HumanTaskStore,
  type HumanTaskRecord
} from "../human-tasks/human-task-store.js";

export interface AttentionItem {
  readonly taskId: string;
  readonly taskType: string;
  readonly title: string;
  readonly explanation: string;
  readonly requiredActionKind: string;
  readonly accountId: string | null;
  readonly personaUid: string | null;
  readonly operationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

export interface AttentionReadServiceOptions {
  readonly database: DatabaseSync;
}

function projectTask(task: HumanTaskRecord): AttentionItem {
  return Object.freeze({
    taskId: task.taskId,
    taskType: task.taskType,
    title: task.title,
    explanation: task.explanation,
    requiredActionKind: task.requiredActionKind,
    accountId: task.accountId,
    personaUid: task.personaUid,
    operationId: task.operationId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt
  });
}

export class AttentionReadService {
  readonly #tasks: HumanTaskStore;

  public constructor(options: AttentionReadServiceOptions) {
    this.#tasks = new HumanTaskStore({
      database: options.database
    });
  }

  public listOpen(): readonly AttentionItem[] {
    return Object.freeze(
      this.#tasks.listOpen().map(projectTask)
    );
  }
}
