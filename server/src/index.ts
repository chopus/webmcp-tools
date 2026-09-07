#!/usr/bin/env node
/**
 * webmcp-browser — MCP server + native messaging host for webmcp-tools.
 *
 * One binary, three modes:
 *  - MCP mode (default): speak MCP over stdio and host the TCP hub that the
 *    Chrome extension's native relay connects to.
 *  - Relay mode (--native-host, or a chrome-extension://... origin in argv,
 *    which Chrome passes when it spawns a native messaging host): bridge
 *    native-messaging frames on stdio to the hub TCP socket.
 *  - Flow mode (--flow <file>): run a flow file with retries, assertions,
 *    and an HTML report against the connected browser.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { detectMode } from "./args.js";
import { Hub } from "./hub.js";
import { log } from "./log.js";
import { createMcpServer } from "./mcp/server.js";
import { runRelay } from "./relay.js";
import { VERSION } from "./version.js";

const USAGE = `webmcp-browser ${VERSION} — MCP server + Chrome native-messaging relay for webmcp-tools

Usage:
  webmcp-browser                     MCP server mode over stdio (default)
  webmcp-browser --native-host       Relay mode: native messaging <-> hub TCP
  webmcp-browser --flow <flow.json>  Run a flow file (retries, assertions, HTML report)
  webmcp-browser --print-mcp-config  Print an MCP client config snippet (JSON)
  webmcp-browser --version           Print the version
  webmcp-browser --help              Show this help

Relay mode is auto-detected: Chrome passes the extension origin
(chrome-extension://<id>/) as an argument, which selects relay mode.
Flow mode takes the same options as the npm script: npm run flow --
flows/google-search.json --var query=capybara.

Environment:
  WEBMCP_HUB_FILE  Override the hub discovery file location
                   (default: <os.tmpdir()>/webmcp-tools-hub.json)
`;

function distDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function printMcpConfig(): void {
  const entry = path.join(distDir(), "index.js");
  const config = {
    mcpServers: {
      "webmcp-browser": {
        command: process.execPath,
        args: [entry],
      },
    },
  };
  process.stdout.write(JSON.stringify(config, null, 2) + "\n");
}

async function runMcpMode(): Promise<void> {
  const hub = new Hub();
  await hub.listen();
  const server = createMcpServer(hub);
  await server.connect(new StdioServerTransport());
  log(`webmcp-browser v${VERSION} MCP server ready on stdio`);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason} received, shutting down`);
    hub.closeSync();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // If the MCP client goes away (stdin EOF / transport closed), exit so the
  // discovery file is removed and the port is released.
  server.server.onclose = () => shutdown("transport closed");
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("exit", () => hub.closeSync());
}

async function main(): Promise<void> {
  switch (detectMode(process.argv.slice(2))) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      break;
    case "help":
      process.stdout.write(USAGE);
      break;
    case "print-mcp-config":
      printMcpConfig();
      break;
    case "relay":
      await runRelay();
      break;
    case "flow": {
      // Dynamic import: MCP and relay mode should not load flow-mode code.
      const { runFlowMode } = await import("./flow/run.js");
      const exitCode = await runFlowMode(process.argv.slice(2));
      process.exit(exitCode);
    }
    case "mcp":
      await runMcpMode();
      break;
  }
}

process.on("uncaughtException", (error) => {
  log(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

main().catch((error) => {
  // Flow-mode CLI errors (bad file, unknown option) are user messages, not crashes.
  if (error instanceof Error && error.name === "FlowError") {
    log(`error: ${error.message}`);
  } else {
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  process.exitCode = 1;
});
