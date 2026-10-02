export const workspaceMetadata = Object.freeze({
  name: "pcms-local",
  baseline: "0.1",
  version: "0.0.0",
  runtime: "node"
} as const);

export type WorkspaceMetadata = typeof workspaceMetadata;
