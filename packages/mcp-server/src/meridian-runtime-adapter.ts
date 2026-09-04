export type ExamplePlatformMode = "read-only" | "plan" | "edit";

export interface ExamplePlatformCanvasConnection {
  readonly kind: "session-path" | "credential-path" | "socket";
  readonly path: string;
}

export interface ExamplePlatformRuntimeProfile {
  readonly kind: "catalog-hermetic" | "private-runtime";
  readonly profileId: string;
  readonly environment: "test" | "staging" | "production";
  readonly localOperator: string;
  readonly sessionId: string;
  readonly stateDirectory: string;
  readonly mode: ExamplePlatformMode;
  readonly canvasConnection?: ExamplePlatformCanvasConnection;
  readonly courseScope?: {
    readonly courseId: string;
  };
  readonly operation?: {
    readonly id: string;
    readonly taskContractDigest: string;
  };
  readonly learnerVault?: {
    readonly vaultId: string;
  };
}

export interface ExamplePlatformSshLaunchConfig {
  readonly host: string;
  readonly remoteRoot: string;
  readonly serverPath: string;
  readonly runtimeProfile: ExamplePlatformRuntimeProfile;
}

export interface ExamplePlatformSshLaunch {
  readonly command: "ssh";
  readonly args: readonly ["-T", string, string];
  readonly meridianEnvironment: Readonly<Record<string, string>>;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pathJoin(root: string, suffix: string): string {
  return `${root.replace(/\/+$/, "")}/${suffix}`;
}

export function mapExamplePlatformEnvironment(
  config: ExamplePlatformSshLaunchConfig,
): Readonly<Record<string, string>> {
  const profile = config.runtimeProfile;
  const profileRoot = pathJoin(profile.stateDirectory, "profile");
  const reportsRoot = pathJoin(
    profile.stateDirectory,
    `reports/${profile.localOperator}`,
  );
  const jobScratchRoot = profile.operation
    ? pathJoin(
        profile.stateDirectory,
        `job-scratch/${profile.localOperator}/${profile.operation.id}`,
      )
    : pathJoin(profile.stateDirectory, `job-scratch/${profile.localOperator}/catalog`);

  const environment: Record<string, string> = {
    HOME: profile.stateDirectory,
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PYTHONUNBUFFERED: "1",
    CHCP_TEAM_KIT_ROOT: config.remoteRoot,
    CHCP_INSTANCE_KIT_ROOT: config.remoteRoot,
    CHCP_INSTANCE_NAME: profile.profileId,
    CHCP_ENVIRONMENT: profile.environment,
    CHCP_STATE_ROOT: profile.stateDirectory,
    CHCP_INSTANCE_STATE_DIR: profile.stateDirectory,
    CHCP_PROFILE_ROOT: profileRoot,
    CHCP_TEAM_SESSION_USER: profile.localOperator,
    CHCP_OPERATOR_JOB_USER: profile.localOperator,
    CHCP_TEAM_CONVERSATION_ID: profile.sessionId,
    CHCP_REPORTS_DIR: reportsRoot,
    CHCP_JOB_SCRATCH_DIR: jobScratchRoot,
    CHCP_TEAM_ACCOUNT_PROFILE_DAEMONS: "0",
    CHCP_TEAM_OPERATION_MODE: profile.mode === "read-only" ? "read" : profile.mode,
  };

  if (profile.mode === "read-only") environment.CHCP_READ_ONLY = "1";
  if (profile.courseScope) environment.CHCP_TEAM_COURSE_ID = profile.courseScope.courseId;
  if (profile.operation) {
    environment.CHCP_TEAM_JOB_ID = profile.operation.id;
    environment.CHCP_OPERATOR_JOB_ID = profile.operation.id;
    environment.CHCP_TEAM_TASK_CONTRACT_DIGEST = profile.operation.taskContractDigest;
  }
  if (profile.learnerVault) {
    environment.CHCP_TEAM_VAULT_ID = profile.learnerVault.vaultId;
  }
  if (profile.canvasConnection?.kind === "session-path") {
    environment.CANVAS_SESSION_PATH = profile.canvasConnection.path;
  }
  if (profile.canvasConnection?.kind === "credential-path") {
    environment.CANVAS_CREDS_PATH = profile.canvasConnection.path;
  }
  if (profile.canvasConnection?.kind === "socket") {
    environment.CHCP_CANVAS_SOCKET = profile.canvasConnection.path;
    environment.CHCP_CANVAS_SESSION_SOCKET = profile.canvasConnection.path;
  }
  if (profile.environment === "test") {
    environment.CHCP_MCP_TELEMETRY_TEST_ROOT = pathJoin(
      profile.stateDirectory,
      "mcp-telemetry",
    );
  }
  return Object.freeze(environment);
}

export function buildExamplePlatformSshLaunch(
  config: ExamplePlatformSshLaunchConfig,
): ExamplePlatformSshLaunch {
  const environment = mapExamplePlatformEnvironment(config);
  const directories = new Set([
    config.runtimeProfile.stateDirectory,
    environment.CHCP_PROFILE_ROOT!,
    environment.CHCP_REPORTS_DIR!,
    environment.CHCP_JOB_SCRATCH_DIR!,
    ...(environment.CHCP_MCP_TELEMETRY_TEST_ROOT
      ? [environment.CHCP_MCP_TELEMETRY_TEST_ROOT]
      : []),
  ]);
  const assignments = Object.entries(environment)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${quoteShell(value)}`)
    .join(" ");
  const remoteCommand = [
    "set -eu",
    `mkdir -p -- ${[...directories].map(quoteShell).join(" ")}`,
    `cd -- ${quoteShell(config.remoteRoot)}`,
    `exec env -i ${assignments} python3 ${quoteShell(config.serverPath)}`,
  ].join("; ");
  return {
    command: "ssh",
    args: ["-T", config.host, remoteCommand],
    meridianEnvironment: environment,
  };
}
