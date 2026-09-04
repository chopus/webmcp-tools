export type RunMode =
  | "mcp"
  | "relay"
  | "version"
  | "help"
  | "print-mcp-config";

/**
 * Decide which mode the binary should run in.
 *
 * - `--version` / `--help` / `--print-mcp-config` are explicit CLI requests.
 * - `--native-host` forces relay mode (used by the launcher scripts).
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
  return "mcp";
}
