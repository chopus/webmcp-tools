export type RunMode =
  | "mcp"
  | "relay"
  | "flow"
  | "version"
  | "help"
  | "print-mcp-config";

/** Default TCP port for the `--http` streamable MCP transport. */
export const DEFAULT_HTTP_PORT = 8930;

function parsePort(raw: string | undefined, flag: string): number {
  const port = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${flag} expects a TCP port between 1 and 65535${
        raw !== undefined ? `, got "${raw}"` : ""
      }`,
    );
  }
  return port;
}

/**
 * Parse the `--http` transport option (an MCP-mode modifier, not a mode).
 *
 * - `--http`            → `DEFAULT_HTTP_PORT`
 * - `--http=<port>`     → that port
 * - `--http --port <port>` / `--http --port=<port>` → that port
 *
 * Returns `undefined` when `--http` is absent (stdio-only MCP mode).
 * Throws a user-readable `Error` on malformed values.
 */
export function parseHttpPort(argv: readonly string[]): number | undefined {
  const hasHttp =
    argv.includes("--http") || argv.some((item) => item.startsWith("--http="));
  if (!hasHttp) return undefined;

  const httpEq = argv.find((item) => item.startsWith("--http="));
  if (httpEq) return parsePort(httpEq.slice("--http=".length), "--http");

  const portEq = argv.find((item) => item.startsWith("--port="));
  if (portEq) return parsePort(portEq.slice("--port=".length), "--port");

  const portIdx = argv.indexOf("--port");
  if (portIdx !== -1) return parsePort(argv[portIdx + 1], "--port");

  return DEFAULT_HTTP_PORT;
}

/**
 * Decide which mode the binary should run in.
 *
 * - `--version` / `--help` / `--print-mcp-config` are explicit CLI requests.
 * - `--native-host` forces relay mode (used by the launcher scripts).
 * - `--flow <file>` runs a flow file against the connected browser.
 * - `--http` (parsed separately by `parseHttpPort`) is a modifier that keeps
 *   MCP mode but additionally serves the streamable HTTP transport.
 * - Chrome passes the caller origin (`chrome-extension://<id>/`) as an argv
 *   item when it spawns a native messaging host — that also selects relay
 *   mode.
 * - Anything else runs the MCP server + hub (the default for MCP clients).
 */
export function detectMode(argv: readonly string[]): RunMode {
  if (argv.includes("--version") || argv.includes("-v")) return "version";
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--print-mcp-config")) return "print-mcp-config";
  if (argv.includes("--native-host")) return "relay";
  if (argv.some((item) => item.startsWith("chrome-extension://"))) return "relay";
  if (argv.includes("--flow")) return "flow";
  return "mcp";
}
