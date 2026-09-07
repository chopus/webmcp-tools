/**
 * Flow runner types — a flow file is plain JSON that drives the connected
 * browser through the same hub the MCP tools use.
 *
 * A flow has:
 *  - `vars`: values that steps interpolate via `{{name}}` / `{{name.path|uri}}`
 *  - `steps`: tool calls with assertions, retries, and save-as-variable
 *  - `finally`: tool calls that always run at the end (cleanup)
 */

/** Operators available to `expect` assertions and `when` conditions. */
export type ExpectOp =
  | "exists" // actual is not undefined/null
  | "equals"
  | "notEquals"
  | "contains" // substring (string), item (array), key (object)
  | "matches" // regex (against String(actual))
  | "in" // actual is one of the items of `value` (array)
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "type" // "string" | "number" | "boolean" | "object" | "array"
  | "lengthGte" // length of a string or array
  | "lengthLte";

export const EXPECT_OPS: readonly ExpectOp[] = [
  "exists",
  "equals",
  "notEquals",
  "contains",
  "matches",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "type",
  "lengthGte",
  "lengthLte",
];

/** One check. `path` reads into the tool result with dot segments and array indices. */
export interface Expectation {
  path: string;
  op: ExpectOp;
  /** Comparison operand for ops that need one. */
  value?: unknown;
  /** Regex source for "matches". */
  regex?: string;
  /** Type name for "type". */
  type?: string;
  /** Human note shown in the report. */
  desc?: string;
}

export interface FlowStep {
  name: string;
  tool: string;
  args?: Record<string, unknown>;
  /**
   * evaluate only: load the page-side function from this file (relative to the
   * flow file) instead of an inline `args.function` string. Lets parsers live
   * in real, versioned JS files — e.g. flows/lib/google-search.js.
   */
  functionFile?: string;
  /** Retries after the first failed attempt (tool error or failed assertion). Default 0. */
  retries?: number;
  /** Delay between attempts. Default 1000. */
  retryDelayMs?: number;
  /** Hub call timeout for this step. Default 120000, capped at 120000. */
  timeoutMs?: number;
  /** Save the tool result under this variable name for later interpolation. */
  save?: string;
  /** Dot path into the result to save instead of the whole result (use with "save"). */
  saveFrom?: string;
  /** Assertions on the tool result. A failed assertion triggers a retry. */
  expect?: Expectation[];
  /** Run this step only when the condition holds (checked against current vars). */
  when?: Expectation;
  /** A failure after retries marks the step "soft" and the flow continues. */
  optional?: boolean;
}

export interface FlowFile {
  name: string;
  description?: string;
  vars?: Record<string, unknown>;
  steps: FlowStep[];
  /** Steps that always run at the end, even after a failure. */
  finally?: FlowStep[];
}

/** Step outcome. "soft" = failed but optional; "skip" = condition false or not reached. */
export type StepStatus = "pass" | "fail" | "soft" | "skip";

export interface AssertionRecord {
  path: string;
  op: ExpectOp;
  /** Expected operand, rendered to a short JSON string for the report. */
  expected?: string;
  /** Actual value at `path`, rendered to a short JSON string for the report. */
  actual?: string;
  pass: boolean;
}

export interface StepRecord {
  index: number;
  section: "steps" | "finally";
  name: string;
  tool: string;
  /** Interpolated arguments actually sent. */
  args?: string;
  when?: { condition: string; passed: boolean };
  status: StepStatus;
  /** Tool calls made, including failed attempts. */
  attempts: number;
  startedAt: string;
  durationMs: number;
  /** Last tool result, rendered to a bounded JSON string. */
  result?: string;
  assertions?: AssertionRecord[];
  error?: string;
  /** Present for screenshot steps that returned image data. */
  screenshot?: { mimeType: string; dataBase64: string };
}

export interface RunRecord {
  flow: { name: string; description?: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "pass" | "fail";
  vars: Record<string, unknown>;
  browser?: { instanceId: string; chromeVersion?: string };
  steps: StepRecord[];
  counts: { pass: number; fail: number; soft: number; skip: number };
}

/**
 * Tool caller the engine drives. Flow mode implements this against the hub;
 * tests implement it with scripts. Must reject on tool errors.
 */
export type ToolCaller = (
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>;
