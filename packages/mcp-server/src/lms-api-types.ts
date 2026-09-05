import type { JsonObject, JsonSchema } from "@morrow/contracts";

export type LmsProvider = "moodle" | "blackboard";

export interface LmsTarget {
  readonly field: string;
  readonly label: string;
  readonly name: string;
}

export interface LmsRead {
  readonly data: unknown;
  readonly targets?: readonly LmsTarget[];
}

export interface LmsApiClient {
  readonly baseUrl: string;
  readonly principalId: string;
  readonly signal: AbortSignal;
  moodle(functionName: string, args: JsonObject): Promise<unknown>;
  blackboard(path: string, method?: "GET" | "PATCH", body?: JsonObject): Promise<unknown>;
}

export interface LmsApiOperation {
  readonly name: string;
  readonly provider: LmsProvider;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly documentation: string;
  readonly requiredFunctions?: readonly string[];
  readonly reviewTool?: string;
  read(client: LmsApiClient, args: JsonObject): Promise<LmsRead>;
  readonly change?: {
    apply(client: LmsApiClient, args: JsonObject, before: LmsRead): Promise<void>;
    matches(before: LmsRead, after: LmsRead, args: JsonObject): boolean;
  };
}
