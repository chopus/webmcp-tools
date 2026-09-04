/**
 * All diagnostics go to stderr. stdout belongs to the MCP protocol (or, in
 * relay mode, to native-messaging frames) and must never contain log output.
 */
export function log(message: string): void {
  process.stderr.write(`webmcp-browser: ${message}\n`);
}
