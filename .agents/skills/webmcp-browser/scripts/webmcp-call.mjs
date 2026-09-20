#!/usr/bin/env node
/**
 * webmcp-call.mjs — call one webmcp-tools MCP tool from the command line.
 *
 * Usage (from anywhere; server found relative to this script):
 *   node webmcp-call.mjs <tool> [jsonArgs|-]  call a tool, print its text result
 *   node webmcp-call.mjs status               get_browser_info, pretty-printed
 *   node webmcp-call.mjs tools                list tool names
 *   node webmcp-call.mjs stop                 stop a server this script started
 *
 * evaluate ergonomics (same as the flow runner's functionFile): shell-quoted
 * JSON on the command line mangles backslashes and quotes in real functions,
 * so the function and args can come from files or stdin instead:
 *   --function-file <path>  file contents become args.function (evaluate only;
 *                           conflicts with an inline args.function)
 *   --args-file <path>      JSON object merged under the inline args (inline
 *                           keys win; values with quotes/backslashes are safe)
 *   jsonArgs of "-"         read the JSON args object from stdin
 *
 * Speaks MCP streamable HTTP to the webmcp-tools server. If nothing listens
 * on the endpoint it starts `server/dist/index.js --http` in the background,
 * waits for the port, and retries tool calls for ~30 s while the extension
 * reconnects to the new hub. The MCP session id is cached in the OS temp dir
 * so repeated invocations reuse one session. Image results (screenshots) are
 * written to `webmcp-shot-<timestamp>.png|jpg` in the current directory and
 * the path is printed.
 *
 * Env: WEBMCP_HTTP_URL — full endpoint URL (default http://127.0.0.1:8930/mcp).
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// <repo>/.agents/skills/webmcp-browser/scripts -> repo root
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "dist", "index.js");
const ENDPOINT = process.env.WEBMCP_HTTP_URL || "http://127.0.0.1:8930/mcp";
const SESSION_FILE = path.join(tmpdir(), "webmcp-skill-session.json");
const PID_FILE = path.join(tmpdir(), "webmcp-skill-server.pid");
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;

function usage() {
  console.log(`webmcp-call — drive the real Chrome through webmcp-tools

  node webmcp-call.mjs <tool> [jsonArgs|-]    call one MCP tool
  node webmcp-call.mjs status                 get_browser_info, pretty-printed
  node webmcp-call.mjs tools                  list tool names
  node webmcp-call.mjs stop                   stop a server started by this script

  --function-file <path>   evaluate: function source from a file
                           (instead of inline args.function)
  --args-file <path>       JSON args object from a file (merged under
                           inline args; inline keys win)
  jsonArgs of "-"          read the JSON args object from stdin

Examples:
  node webmcp-call.mjs new_tab '{"url":"https://example.com"}'
  node webmcp-call.mjs snapshot
  node webmcp-call.mjs click '{"selector":"a.next"}'
  node webmcp-call.mjs screenshot '{"fullPage":true}'
  node webmcp-call.mjs evaluate --function-file probe.js --args-file vars.json
  cat vars.json | node webmcp-call.mjs evaluate --function-file probe.js -

Endpoint: ${ENDPOINT} (override with WEBMCP_HTTP_URL)`);
}

async function endpointUp() {
  try {
    // Any HTTP answer — even 400 "initialize first" — means the server listens.
    await fetch(ENDPOINT, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await endpointUp()) return { startedByUs: false };
  const child = spawn(process.execPath, [SERVER_ENTRY, "--http"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 40; i++) {
    if (await endpointUp()) return { startedByUs: true };
    await sleep(500);
  }
  throw new Error(
    `the webmcp server did not come up at ${ENDPOINT}. ` +
      `Build it first: npm run build (entry: ${SERVER_ENTRY})`,
  );
}

async function parseRpc(res, id) {
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  const payloads = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) {
        try {
          payloads.push(JSON.parse(data));
        } catch {
          /* keep-alive comment or partial line */
        }
      }
    }
  } else if (text) {
    try {
      payloads.push(JSON.parse(text));
    } catch {
      /* non-JSON body */
    }
  }
  return payloads.find((p) => p && p.id === id) ?? null;
}

function loadSession() {
  try {
    const parsed = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    return parsed.endpoint === ENDPOINT ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

async function initialize() {
  const id = nextId++;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "webmcp-skill", version: "0.1.0" },
      },
    }),
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize response carried no mcp-session-id header");
  await parseRpc(res, id);
  const note = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await note.text().catch(() => "");
  writeFileSync(SESSION_FILE, JSON.stringify({ endpoint: ENDPOINT, sessionId }));
  return sessionId;
}

async function request(method, params, sessionId) {
  const id = nextId++;
  const headers = { ...HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { res, id };
}

async function callToolOnce(name, args) {
  let sessionId = loadSession();
  let out = await request("tools/call", { name, arguments: args ?? {} }, sessionId);
  if (out.res.status === 404 || (out.res.status === 400 && !sessionId)) {
    // Stale cached session or a server restarted under us: re-initialize once.
    sessionId = await initialize();
    out = await request("tools/call", { name, arguments: args ?? {} }, sessionId);
  }
  const message = await parseRpc(out.res, out.id);
  if (!message) throw new Error(`no JSON-RPC response (HTTP ${out.res.status})`);
  if (message.error) {
    const code = message.error.code ? ` [${message.error.code}]` : "";
    return { error: `${message.error.message}${code}` };
  }
  return { result: message.result };
}

const browserGone = (text) =>
  /extension_not_connected|no connected browser|not connected/i.test(text ?? "");

/** Retry while the extension reconnects to a hub this script just started. */
async function callTool(name, args, startedByUs) {
  for (let attempt = 0; ; attempt++) {
    const out = await callToolOnce(name, args);
    const failure = out.error ?? (out.result?.isError ? resultText(out.result) : null);
    if (failure && startedByUs && attempt < 15 && browserGone(failure)) {
      await sleep(2000);
      continue;
    }
    if (out.error) return { error: out.error };
    if (out.result?.isError) return { error: resultText(out.result) || "tool error" };
    return out;
  }
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function printResult(result) {
  const content = result?.content ?? [];
  if (content.length === 0) console.log(JSON.stringify(result));
  for (const item of content) {
    if (item.type === "text") {
      console.log(item.text);
    } else if (item.type === "image" && item.data) {
      const ext = (item.mimeType || "").includes("jpeg") ? "jpg" : "png";
      const file = path.resolve(process.cwd(), `webmcp-shot-${Date.now()}.${ext}`);
      writeFileSync(file, Buffer.from(item.data, "base64"));
      console.log(`[image saved: ${file}]`);
    } else {
      console.log(JSON.stringify(item));
    }
  }
}

function stopServer() {
  let pid = null;
  try {
    pid = Number(readFileSync(PID_FILE, "utf8").trim());
  } catch {
    /* no pid file */
  }
  let stopped = false;
  if (pid) {
    try {
      process.kill(pid);
      stopped = true;
    } catch {
      /* already gone */
    }
  }
  rmSync(SESSION_FILE, { force: true });
  rmSync(PID_FILE, { force: true });
  console.log(
    stopped
      ? `stopped the webmcp server this skill started (pid ${pid})`
      : "no server started by this skill is running (cleared cached session)",
  );
}

async function listTools() {
  let sessionId = loadSession();
  let out = await request("tools/list", {}, sessionId);
  if (out.res.status === 404 || (out.res.status === 400 && !sessionId)) {
    sessionId = await initialize();
    out = await request("tools/list", {}, sessionId);
  }
  const message = await parseRpc(out.res, out.id);
  const tools = message?.result?.tools ?? [];
  for (const tool of tools) {
    const description = (tool.description || "").split("\n")[0];
    console.log(`${tool.name} — ${description}`);
  }
  if (tools.length === 0) console.log("(no tools listed)");
}

async function printStatus(startedByUs) {
  const out = await callTool("get_browser_info", {}, startedByUs);
  if (out.error) {
    console.error(out.error);
    process.exit(1);
  }
  let info;
  try {
    info = JSON.parse(resultText(out.result));
  } catch {
    printResult(out.result);
    return;
  }
  console.log(`Chrome ${info.chromeVersion} on ${info.platform}`);
  console.log(`answering instance: ${info.instanceId}`);
  for (const instance of info.instances ?? []) {
    console.log(`connected browser: ${JSON.stringify(instance)}`);
  }
  console.log(`user agent: ${info.userAgent}`);
}

function readStdin(label) {
  if (process.stdin.isTTY) {
    console.error(`"${label}" reads the JSON args from stdin, but nothing is piped in`);
    process.exit(2);
  }
  return readFileSync(0, "utf8");
}

/** Parse argv into { command, argsJson, functionFile, argsFile }. */
function parseArgv(argv) {
  const out = { command: null, argsJson: undefined, functionFile: null, argsFile: null };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    const valueOf = (flag) => {
      if (item === flag) {
        const value = argv[++i];
        if (value === undefined) {
          console.error(`${flag} expects a path`);
          process.exit(2);
        }
        return value;
      }
      return item.startsWith(flag + "=") ? item.slice(flag.length + 1) : null;
    };
    const fnFile = valueOf("--function-file");
    if (fnFile) { out.functionFile = fnFile; continue; }
    const aFile = valueOf("--args-file");
    if (aFile) { out.argsFile = aFile; continue; }
    if (out.command === null) { out.command = item; continue; }
    if (out.argsJson === undefined) { out.argsJson = item; continue; }
    console.error(`unexpected extra argument "${item}"`);
    process.exit(2);
  }
  return out;
}

/** Build the tool args: inline JSON (- = stdin), then --args-file, then --function-file. */
function buildToolArgs(command, parsed) {
  let args = {};
  if (parsed.argsJson !== undefined) {
    const raw = parsed.argsJson === "-" ? readStdin("-") : parsed.argsJson;
    try {
      args = JSON.parse(raw);
    } catch (error) {
      console.error(`args must be valid JSON: ${error.message}`);
      process.exit(2);
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      console.error("args must be a JSON object");
      process.exit(2);
    }
  }
  if (parsed.argsFile) {
    let fromFile;
    try {
      fromFile = JSON.parse(readFileSync(parsed.argsFile, "utf8"));
    } catch (error) {
      console.error(`--args-file ${parsed.argsFile}: ${error.message}`);
      process.exit(2);
    }
    if (fromFile === null || typeof fromFile !== "object" || Array.isArray(fromFile)) {
      console.error(`--args-file ${parsed.argsFile} must contain a JSON object`);
      process.exit(2);
    }
    args = { ...fromFile, ...args };
  }
  if (parsed.functionFile) {
    if (command !== "evaluate") {
      console.error("--function-file is only valid with the evaluate tool");
      process.exit(2);
    }
    if (typeof args.function === "string") {
      console.error("use either --function-file or an inline args.function, not both");
      process.exit(2);
    }
    const source = readFileSync(parsed.functionFile, "utf8");
    if (!source.trim()) {
      console.error(`--function-file ${parsed.functionFile} is empty`);
      process.exit(2);
    }
    args.function = source;
  }
  return args;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed.command;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "stop") {
    stopServer();
    return;
  }

  const { startedByUs } = await ensureServer();
  if (startedByUs) {
    console.error(`[webmcp-call] started ${SERVER_ENTRY} --http (stop with: webmcp-call.mjs stop)`);
  }

  if (command === "tools") {
    await listTools();
    return;
  }
  if (command === "status") {
    await printStatus(startedByUs);
    return;
  }

  const args = buildToolArgs(command, parsed);

  const out = await callTool(command, args, startedByUs);
  if (out.error) {
    console.error(out.error);
    process.exit(1);
  }
  printResult(out.result);
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exit(1);
});
