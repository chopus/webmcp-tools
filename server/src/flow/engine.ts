/**
 * Flow engine — executes a FlowFile against an injected ToolCaller.
 *
 * Pure logic, no browser and no file I/O: flow mode wires the hub in, unit
 * tests wire scripted callers in. The engine owns interpolation, assertions,
 * retries, `when` conditions, save-as-variable, and screenshot extraction.
 */
import {
  EXPECT_OPS,
  type AssertionRecord,
  type Expectation,
  type ExpectOp,
  type FlowFile,
  type FlowStep,
  type RunRecord,
  type StepRecord,
  type StepStatus,
  type ToolCaller,
} from "./types.js";

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

const MAX_RESULT_JSON = 4000; // bound the report size (page text, results, …)
const MAX_ACTUAL_JSON = 300;
const DEFAULT_RETRY_DELAY_MS = 1000;

// ----------------------------------------------------------------- templates

const TEMPLATE_RE = /\{\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*(?:\|\s*([A-Za-z_$][\w$]*)\s*)?\}\}/g;
const FILTERS = ["uri"] as const;

/** Read `a.b.0.c` out of an object; undefined when any segment is missing. */
export function getPath(root: unknown, path: string): unknown {
  let value: unknown = root;
  for (const segment of path.split(".")) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      value = value[index];
    } else if (typeof value === "object") {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function resolveTemplate(path: string, filter: string | undefined, vars: Record<string, unknown>): unknown {
  let value = getPath(vars, path);
  if (value === undefined) {
    throw new FlowError(`template "{{${path}}}" refers to an unknown variable`);
  }
  if (filter === undefined || filter === "") return value;
  if (filter === "uri") return encodeURIComponent(String(value));
  throw new FlowError(`unknown template filter "${filter}" (known: ${FILTERS.join(", ")})`);
}

/**
 * Replace `{{name.path|filter}}` inside a structure. A string that is exactly
 * one template returns the raw value, so numbers and objects keep their type.
 */
export function interpolate<T>(value: T, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const full = /^\s*\{\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*(?:\|\s*([A-Za-z_$][\w$]*)\s*)?\}\}\s*$/.exec(value);
    if (full) return resolveTemplate(full[1], full[2], vars);
    return value.replace(TEMPLATE_RE, (_all, path: string, filter?: string) =>
      String(resolveTemplate(path, filter, vars)));
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(item, vars);
    }
    return out;
  }
  return value;
}

// --------------------------------------------------------------- assertions

function jsonPreview(value: unknown, cap: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function lengthOf(value: unknown): number | null {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return null;
}

/** Evaluate one operator. Never throws — a bad operand is a failed check. */
export function evaluateExpectation(actual: unknown, e: Expectation): boolean {
  switch (e.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return JSON.stringify(actual) === JSON.stringify(e.value);
    case "notEquals":
      return JSON.stringify(actual) !== JSON.stringify(e.value);
    case "contains": {
      if (typeof actual === "string") return actual.includes(String(e.value));
      if (Array.isArray(actual)) return actual.some((item) => JSON.stringify(item) === JSON.stringify(e.value));
      if (actual !== null && typeof actual === "object") return String(e.value) in (actual as object);
      return false;
    }
    case "matches":
      try {
        return new RegExp(String(e.regex)).test(String(actual));
      } catch {
        return false;
      }
    case "in":
      return Array.isArray(e.value) && e.value.some((item) => JSON.stringify(item) === JSON.stringify(actual));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = Number(actual);
      const right = Number(e.value);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      if (e.op === "gt") return left > right;
      if (e.op === "gte") return left >= right;
      if (e.op === "lt") return left < right;
      return left <= right;
    }
    case "type":
      return typeOf(actual) === e.type;
    case "lengthGte":
    case "lengthLte": {
      const length = lengthOf(actual);
      const target = Number(e.value);
      if (length === null || !Number.isFinite(target)) return false;
      return e.op === "lengthGte" ? length >= target : length <= target;
    }
    default:
      return false;
  }
}

function assertionRecords(result: unknown, expectations: Expectation[]): AssertionRecord[] {
  return expectations.map((e) => ({
    path: e.path,
    op: e.op,
    expected: e.value !== undefined || e.regex !== undefined || e.type !== undefined
      ? jsonPreview(e.value !== undefined ? e.value : e.regex !== undefined ? e.regex : e.type, MAX_ACTUAL_JSON)
      : undefined,
    actual: jsonPreview(getPath(result, e.path), MAX_ACTUAL_JSON),
    pass: evaluateExpectation(getPath(result, e.path), e),
  }));
}

// ---------------------------------------------------------------- validation

/**
 * Fail fast on a malformed flow: unknown tools, unknown operators, missing
 * fields. `knownTools` is the live MCP tool list (TOOL_NAMES).
 */
export function validateFlow(flow: FlowFile, knownTools: readonly string[]): void {
  if (!flow || typeof flow !== "object") throw new FlowError("flow must be a JSON object");
  if (typeof flow.name !== "string" || !flow.name.trim()) throw new FlowError('flow needs a non-empty "name"');
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new FlowError('flow needs a non-empty "steps" array');
  }
  if (flow.vars !== undefined && (flow.vars === null || typeof flow.vars !== "object" || Array.isArray(flow.vars))) {
    throw new FlowError('"vars" must be an object');
  }
  const checkStep = (step: FlowStep, where: string): void => {
    if (!step || typeof step !== "object") throw new FlowError(`${where}: each step must be an object`);
    if (typeof step.name !== "string" || !step.name.trim()) {
      throw new FlowError(`${where}: each step needs a non-empty "name"`);
    }
    if (typeof step.tool !== "string" || !knownTools.includes(step.tool)) {
      throw new FlowError(`${where} "${step.name}": unknown tool "${step.tool}" (known: ${knownTools.length} tools)`);
    }
    if (step.args !== undefined && (step.args === null || typeof step.args !== "object" || Array.isArray(step.args))) {
      throw new FlowError(`${where} "${step.name}": "args" must be an object`);
    }
    if (step.functionFile !== undefined) {
      if (typeof step.functionFile !== "string" || !step.functionFile.trim()) {
        throw new FlowError(`${where} "${step.name}": "functionFile" must be a non-empty path`);
      }
      if (step.tool !== "evaluate") {
        throw new FlowError(`${where} "${step.name}": "functionFile" is only valid with the evaluate tool`);
      }
      if (step.args && typeof step.args === "object" && !Array.isArray(step.args) &&
          "function" in (step.args as Record<string, unknown>)) {
        throw new FlowError(`${where} "${step.name}": use either "functionFile" or an inline args.function, not both`);
      }
    }
    const checkExpectation = (e: Expectation, kind: string): void => {
      if (!e || typeof e !== "object") throw new FlowError(`${where} "${step.name}": ${kind} must be an object`);
      if (typeof e.path !== "string" || !e.path) {
        throw new FlowError(`${where} "${step.name}": ${kind} needs a "path"`);
      }
      if (!EXPECT_OPS.includes(e.op)) {
        throw new FlowError(
          `${where} "${step.name}": unknown operator "${e.op}" (known: ${EXPECT_OPS.join(", ")})`,
        );
      }
    };
    for (const e of step.expect ?? []) checkExpectation(e, "an expect entry");
    if (step.when) checkExpectation(step.when, '"when"');
    if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0)) {
      throw new FlowError(`${where} "${step.name}": "retries" must be a non-negative integer`);
    }
    if (step.save !== undefined && (typeof step.save !== "string" || !/^[A-Za-z_$][\w$]*$/.test(step.save))) {
      throw new FlowError(`${where} "${step.name}": "save" must be a plain variable name`);
    }
    if (step.saveFrom !== undefined && (typeof step.saveFrom !== "string" || !step.saveFrom.trim())) {
      throw new FlowError(`${where} "${step.name}": "saveFrom" must be a non-empty dot path`);
    }
  };
  flow.steps.forEach((step) => checkStep(step, "steps"));
  (flow.finally ?? []).forEach((step) => checkStep(step, "finally"));
}

/**
 * Resolve `functionFile` steps: read each file through `readSource` (paths
 * are relative to the flow file) and set `args.function` to the file
 * contents. I/O is injected, so tests use a fake reader. Call after
 * validateFlow — the tool check there already ensured evaluate-only use.
 */
export function materializeFunctionFiles(
  flow: FlowFile,
  readSource: (relativePath: string) => string,
): FlowFile {
  const resolveStep = (step: FlowStep): FlowStep => {
    if (!step.functionFile) return step;
    let source: string;
    try {
      source = readSource(step.functionFile);
    } catch (error) {
      throw new FlowError(
        `step "${step.name}": cannot read functionFile "${step.functionFile}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!source.trim()) {
      throw new FlowError(`step "${step.name}": functionFile "${step.functionFile}" is empty`);
    }
    return { ...step, args: { ...(step.args ?? {}), function: source } };
  };
  return {
    ...flow,
    steps: flow.steps.map(resolveStep),
    finally: (flow.finally ?? []).map(resolveStep),
  };
}

// ----------------------------------------------------------------- execution

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describeExpectation(e: Expectation): string {
  const operand =
    e.value !== undefined ? JSON.stringify(e.value)
    : e.regex !== undefined ? `/${e.regex}/`
    : e.type !== undefined ? `"${e.type}"`
    : "";
  return `${e.path} ${e.op}${operand ? ` ${operand}` : ""}${e.desc ? ` — ${e.desc}` : ""}`;
}

function screenshotOf(tool: string, result: unknown): StepRecord["screenshot"] | undefined {
  if (tool !== "screenshot" || result === null || typeof result !== "object") return undefined;
  const data = (result as Record<string, unknown>).dataBase64;
  if (typeof data !== "string" || !data) return undefined;
  const format = (result as Record<string, unknown>).format;
  return { mimeType: format === "jpeg" ? "image/jpeg" : "image/png", dataBase64: data };
}

function resultPreview(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  const redacted = result !== null && typeof result === "object" && "dataBase64" in (result as object)
    ? { ...(result as Record<string, unknown>), dataBase64: "[image data omitted]" }
    : result;
  return jsonPreview(redacted, MAX_RESULT_JSON);
}

async function executeStep(
  step: FlowStep,
  section: "steps" | "finally",
  index: number,
  vars: Record<string, unknown>,
  callTool: ToolCaller,
): Promise<StepRecord> {
  const record: StepRecord = {
    index,
    section,
    name: step.name,
    tool: step.tool,
    status: "skip",
    attempts: 0,
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  const start = Date.now();

  const failNow = (error: unknown): StepRecord => {
    record.status = step.optional ? "soft" : "fail";
    record.error = error instanceof Error ? error.message : String(error);
    record.durationMs = Date.now() - start;
    return record;
  };

  // Expectation operands may reference variables ("value": "{{query}}") —
  // interpolate them up front. `when` uses the same mechanism. All of this is
  // deterministic: a bad template fails the step immediately instead of
  // burning retries.
  const interpolated = (e: Expectation): Expectation =>
    e.value === undefined ? e : { ...e, value: interpolate(e.value, vars) };

  let when: Expectation | undefined;
  let args: Record<string, unknown>;
  let expectations: Expectation[];
  try {
    when = step.when ? interpolated(step.when) : undefined;
    args = (interpolate(step.args ?? {}, vars) as Record<string, unknown>) ?? {};
    expectations = (step.expect ?? []).map(interpolated);
    record.args = jsonPreview(args, MAX_RESULT_JSON);
  } catch (error) {
    return failNow(error);
  }

  if (when) {
    const passed = evaluateExpectation(getPath(vars, when.path), when);
    record.when = { condition: describeExpectation(when), passed };
    if (!passed) {
      record.durationMs = Date.now() - start;
      return record; // status stays "skip"
    }
  }

  const retries = step.retries ?? 0;
  const retryDelayMs = step.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    record.attempts = attempt + 1;
    try {
      const result = await callTool(step.tool, args, step.timeoutMs ?? 120000);
      record.result = resultPreview(result);
      const shot = screenshotOf(step.tool, result);
      if (shot) record.screenshot = shot;
      if (expectations.length > 0) {
        record.assertions = assertionRecords(result, expectations);
        const failed = record.assertions.filter((a) => !a.pass);
        if (failed.length > 0) {
          lastError =
            `assertion failed: ${failed.map((a) => `${a.path} ${a.op} — got ${a.actual ?? "undefined"}`).join("; ")}`;
          if (attempt < retries) {
            await sleep(retryDelayMs);
            continue;
          }
          record.status = step.optional ? "soft" : "fail";
          record.error = lastError;
          record.durationMs = Date.now() - start;
          return record;
        }
      }
      if (step.save) {
        const toSave = step.saveFrom !== undefined ? getPath(result, step.saveFrom) : result;
        if (toSave === undefined) {
          record.status = step.optional ? "soft" : "fail";
          record.error = `saveFrom path "${step.saveFrom}" not found in the result`;
          record.durationMs = Date.now() - start;
          return record;
        }
        vars[step.save] = toSave;
      }
      record.status = "pass";
      record.durationMs = Date.now() - start;
      return record;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }

  record.status = step.optional ? "soft" : "fail";
  record.error = lastError;
  record.durationMs = Date.now() - start;
  return record;
}

export interface RunFlowOptions {
  /** Extra variables; they override flow `vars`. CLI `--var` feeds this. */
  vars?: Record<string, unknown>;
  /** Recorded on the run for the report header. */
  browser?: { instanceId: string; chromeVersion?: string };
}

/** Execute a validated flow. Non-optional failures abort; `finally` always runs. */
export async function runFlow(
  flow: FlowFile,
  callTool: ToolCaller,
  options: RunFlowOptions = {},
): Promise<RunRecord> {
  const vars: Record<string, unknown> = { ...(flow.vars ?? {}), ...(options.vars ?? {}) };
  const startedAt = new Date();
  const steps: StepRecord[] = [];
  let aborted = false;
  let index = 0;

  for (const step of flow.steps) {
    if (aborted) {
      steps.push({
        index: index++,
        section: "steps",
        name: step.name,
        tool: step.tool,
        status: "skip",
        attempts: 0,
        startedAt: new Date().toISOString(),
        durationMs: 0,
      });
      continue;
    }
    const record = await executeStep(step, "steps", index++, vars, callTool);
    steps.push(record);
    if (record.status === "fail") aborted = true;
  }

  for (const step of flow.finally ?? []) {
    steps.push(await executeStep(step, "finally", index++, vars, callTool));
  }

  const finishedAt = new Date();
  const counts = { pass: 0, fail: 0, soft: 0, skip: 0 };
  for (const step of steps) counts[step.status] += 1;

  return {
    flow: { name: flow.name, description: flow.description },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: counts.fail > 0 ? "fail" : "pass",
    vars,
    browser: options.browser,
    steps,
    counts,
  };
}
