/**
 * `--flow <file>` mode — run a flow file against the connected browser.
 *
 * Starts a hub (the extension's relay reconnects to the newest hub file),
 * waits for a browser, executes the flow through the same request path the
 * MCP tools use, prints one line per step, and writes an HTML + JSON report.
 * Exit code 0 = every non-optional step passed, 1 = failure or setup error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hub } from "../hub.js";
import { log } from "../log.js";
import { MAX_TOOL_TIMEOUT_MS, TOOL_NAMES } from "../mcp/server.js";
import { FlowError, materializeFunctionFiles, runFlow, validateFlow } from "./engine.js";
import { renderHtmlReport, renderJsonReport } from "./report.js";
import type { FlowFile } from "./types.js";

const USAGE = `usage: webmcp-browser --flow <flow.json> [options]

options:
  --var name=value     Set a flow variable (repeatable). Overrides flow "vars".
                       Numbers and true/false are parsed as such.
  --out-dir <dir>      Report directory (default: reports)
  --instance-id <id>   Pin a specific connected browser
  --browser-timeout-ms <ms>  How long to wait for a browser (default: 60000)

example:
  webmcp-browser --flow flows/google-search.json --var query=capybara
`;

interface CliOptions {
  flowPath: string;
  vars: Record<string, unknown>;
  outDir: string;
  instanceId?: string;
  browserTimeoutMs: number;
}

function parseCli(argv: readonly string[]): CliOptions {
  const vars: Record<string, unknown> = {};
  const options: Partial<CliOptions> = { vars, outDir: "reports", browserTimeoutMs: 60000 };
  const parseScalar = (raw: string): unknown => {
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--flow":
        options.flowPath = argv[++i];
        break;
      case "--var": {
        const pair = argv[++i];
        if (pair === undefined || !pair.includes("=")) {
          throw new FlowError(`--var expects name=value, got "${pair ?? "nothing"}"`);
        }
        const eq = pair.indexOf("=");
        vars[pair.slice(0, eq)] = parseScalar(pair.slice(eq + 1));
        break;
      }
      case "--out-dir":
        options.outDir = argv[++i];
        break;
      case "--instance-id":
        options.instanceId = argv[++i];
        break;
      case "--browser-timeout-ms":
        options.browserTimeoutMs = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new FlowError(`unknown flow option "${arg}"\n\n${USAGE}`);
    }
  }
  if (!options.flowPath) throw new FlowError(`--flow <file> is required\n\n${USAGE}`);
  const timeout = options.browserTimeoutMs;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    throw new FlowError("--browser-timeout-ms must be a non-negative number");
  }
  options.browserTimeoutMs = timeout;
  return options as CliOptions;
}

function loadFlow(path: string): FlowFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new FlowError(`cannot read flow file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FlowError(`flow file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateFlow(parsed as FlowFile, TOOL_NAMES);
  // functionFile paths are relative to the flow file (flows/lib/…).
  return materializeFunctionFiles(parsed as FlowFile, (rel) =>
    readFileSync(join(dirname(path), rel), "utf8"),
  );
}

/** First real browser instance (synthetic `conn-N` ids belong to stale builds). */
function pickInstance(hub: Hub, wanted?: string): { instanceId: string; chromeVersion?: string } | null {
  const instances = hub.listInstances();
  if (wanted) return instances.find((i) => i.instanceId === wanted) ?? null;
  const real = instances.filter((i) => !/^conn-\d+$/.test(i.instanceId));
  return real.length > 0 ? real[real.length - 1] : null;
}

async function waitForBrowser(
  hub: Hub,
  options: CliOptions,
): Promise<{ instanceId: string; chromeVersion?: string }> {
  const deadline = Date.now() + options.browserTimeoutMs;
  for (;;) {
    const found = pickInstance(hub, options.instanceId);
    if (found) return found;
    if (Date.now() >= deadline) {
      const seen = hub.listInstances().map((i) => i.instanceId).join(", ") || "none";
      throw new FlowError(
        options.instanceId
          ? `browser instance "${options.instanceId}" did not connect within ${options.browserTimeoutMs}ms (connected: ${seen})`
          : `no browser connected within ${options.browserTimeoutMs}ms — is the extension loaded and the native host installed? (connected: ${seen})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const STATUS_LINE: Record<string, string> = { pass: "PASS", fail: "FAIL", soft: "SOFT", skip: "SKIP" };

/** Entry point for `--flow` mode. Returns the process exit code. */
export async function runFlowMode(argv: readonly string[]): Promise<number> {
  const options = parseCli(argv);
  const flow = loadFlow(options.flowPath);

  const hub = new Hub();
  try {
    await hub.listen();
    process.on("exit", () => hub.closeSync());

    log(`flow "${flow.name}": waiting up to ${options.browserTimeoutMs / 1000}s for a browser...`);
    const browser = await waitForBrowser(hub, options);
    log(
      `flow "${flow.name}": browser ${browser.instanceId}` +
        `${browser.chromeVersion ? ` (Chrome ${browser.chromeVersion})` : ""}`,
    );

    const callTool = (tool: string, args: Record<string, unknown>, timeoutMs: number) =>
      hub.request(tool, args, Math.min(Math.max(1, Math.floor(timeoutMs)), MAX_TOOL_TIMEOUT_MS), browser.instanceId);

    const run = await runFlow(flow, callTool, { vars: options.vars, browser });
    for (const step of run.steps) {
      const detail = step.error ? ` (${step.error.slice(0, 200)})` : "";
      const attempts = step.attempts > 1 ? `, ${step.attempts} attempts` : "";
      const line = `  ${STATUS_LINE[step.status]} ${step.name} [${step.tool}] ${step.durationMs} ms${attempts}${detail}`;
      if (step.status === "fail") console.error(line);
      else console.log(line);
    }

    const stamp = run.startedAt.replace(/[:.]/g, "-").slice(0, 19);
    const base = `${flow.name.replace(/[^\w-]+/g, "-")}-${stamp}`;
    const outDir = options.outDir;
    try {
      mkdirSync(outDir, { recursive: true });
      const htmlPath = join(outDir, `${base}.html`);
      const jsonPath = join(outDir, `${base}.json`);
      writeFileSync(htmlPath, renderHtmlReport(run));
      writeFileSync(jsonPath, renderJsonReport(run));
      console.log(
        `\nflow "${flow.name}": ${run.status.toUpperCase()} — ${run.counts.pass} passed, ${run.counts.fail} failed,` +
          ` ${run.counts.soft} soft-failed, ${run.counts.skip} skipped in ${run.durationMs} ms`,
      );
      console.log(`reports: ${htmlPath} . ${jsonPath}`);
    } catch (error) {
      console.error(`report writing failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return run.status === "pass" ? 0 : 1;
  } finally {
    // Always release the port and the discovery file, including on errors —
    // otherwise a listening hub would keep the process alive forever.
    hub.closeSync();
  }
}
