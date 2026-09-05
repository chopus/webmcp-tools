#!/usr/bin/env node
/**
 * scripts/e2e.mjs — full-stack end-to-end harness for webmcp-tools.
 *
 * Drives the entire chain for real:
 *
 *   MCP client (this process, @modelcontextprotocol/sdk)
 *     ⟷ stdio ⟷ MCP server + hub (server/dist/index.js)
 *     ⟷ TCP 127.0.0.1 ⟷ native relay (spawned by Chrome)
 *     ⟷ native messaging ⟷ extension service worker (extension/)
 *     ⟷ real Chrome tabs (fresh profile, real chrome.exe — no puppeteer)
 *
 * The extension is loaded into a freshly-launched Chrome via CDP
 * `Extensions.loadUnpacked` (the replacement for the removed --load-extension
 * flag). CDP is used ONLY here, by the test harness, to load the unpacked
 * extension — the product itself never needs a debugging port for its
 * transport (it attaches chrome.debugger only for trusted input, full-page
 * screenshots and network capture, per PROTOCOL.md).
 *
 * Usage:  npm run build && npm run install-host && npm run e2e
 * Exit code 0 = all steps passed, 1 = any failure or watchdog abort.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEMOS_DIR = path.join(REPO_ROOT, "demos");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "dist", "index.js");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension").replace(/\\/g, "/");

const WATCHDOG_MS = 180_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;
const EXTENSION_CONNECT_TIMEOUT_MS = 30_000;

// ----------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promiseFactory, ms, label) {
  // promiseFactory: () => Promise — invoked lazily so we never race an
  // already-started promise into an unhandled rejection.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promiseFactory().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function findChrome() {
  const candidates = [];
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const la = process.env.LOCALAPPDATA;
    candidates.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe")
    );
    if (la) candidates.push(path.join(la, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    );
  }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// ------------------------------------------------------------- static server

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function startDemoServer(root) {
  const rootNorm = path.normalize(root);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad url");
      return;
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    const filePath = path.normalize(path.join(rootNorm, pathname));
    if (filePath !== rootNorm && !filePath.startsWith(rootNorm + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`not found: ${pathname}`);
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.on("error", (e) => console.error(`[demos] http server error: ${e.message}`));
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ------------------------------------------------------------ native host

async function installNativeHost(log) {
  const ps1 = path.join(REPO_ROOT, "installer", "install-host.ps1");
  const sh = path.join(REPO_ROOT, "installer", "install-host.sh");
  let child;
  if (process.platform === "win32") {
    if (!fs.existsSync(ps1)) throw new Error(`installer not found: ${ps1}`);
    child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"]
    });
  } else {
    if (!fs.existsSync(sh)) throw new Error(`installer not found: ${sh}`);
    child = spawn("sh", [sh], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  }
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const code = await withTimeout(
    () => new Promise((resolve, reject) => {
      child.once("close", (c) => resolve(c));
      child.once("error", reject);
    }),
    90_000,
    "native host installer"
  ).catch((e) => { try { child.kill(); } catch {} throw e; });
  const trimmed = out.trim();
  if (code === 0) {
    log(`native host installer exited 0${trimmed ? `\n  ${trimmed.split("\n").join("\n  ")}` : ""}`);
  } else {
    // Non-fatal: most commonly "already installed".
    log(`WARNING: native host installer exited ${code} (continuing — likely already installed)\n  ${trimmed.split("\n").join("\n  ")}`);
  }
}

// ----------------------------------------------------------------- CDP bits

async function waitForCdpEndpoint(port, timeoutMs = 30_000) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = "unknown error";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(300);
  }
  throw new Error(`Chrome CDP endpoint ${url} not reachable within ${timeoutMs}ms (${lastErr})`);
}

/**
 * Connect to the browser-level CDP websocket and load the unpacked extension.
 * Uses the GLOBAL WebSocket (Node >= 22). Returns { ws, extensionId }.
 */
function cdpLoadUnpacked(wsUrl, extDir, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`Extensions.loadUnpacked timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (msg) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } reject(new Error(msg)); };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: extDir } }));
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg || msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(`Extensions.loadUnpacked failed: ${JSON.stringify(msg.error)}`));
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      resolve({ ws, extensionId: msg.result && msg.result.extensionId });
    });
    ws.addEventListener("error", () => fail("CDP websocket error (browser endpoint)"));
    ws.addEventListener("close", () => fail("CDP websocket closed before loadUnpacked replied"));
  });
}

// ------------------------------------------------------------ MCP client glue

let mcpClient = null;

function textContentOf(res) {
  const blocks = (res && Array.isArray(res.content)) ? res.content : [];
  return blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

function imageContentOf(res) {
  const blocks = (res && Array.isArray(res.content)) ? res.content : [];
  return blocks.find((b) => b && b.type === "image") || null;
}

/** callTool wrapper: returns the raw CallToolResult; throws on isError/timeout. */
async function call(name, args = {}, opts = {}) {
  const { expectOk = true, timeoutMs = TOOL_CALL_TIMEOUT_MS } = opts;
  if (!mcpClient) throw new Error("MCP client not connected");
  const finalArgs = ctx.instanceId && args.instanceId === undefined
    ? { ...args, instanceId: ctx.instanceId }
    : args;
  const res = await withTimeout(
    () => mcpClient.callTool({ name, arguments: finalArgs }),
    timeoutMs,
    `tool ${name}`
  );
  if (expectOk && res && res.isError) {
    throw new Error(`tool ${name} returned an error: ${textContentOf(res).slice(0, 300)}`);
  }
  return res;
}

/** Parse the pretty-JSON text body most tools return. */
function jsonOf(name, res) {
  const text = textContentOf(res);
  // snapshot responses are "<human-readable refs> --- JSON --- {json}"
  const marker = text.indexOf("--- JSON ---");
  const payload = marker >= 0 ? text.slice(marker + "--- JSON ---".length).trim() : text;
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`tool ${name}: expected JSON text response, got: ${text.slice(0, 200)}`);
  }
}

/** Combined call + JSON.parse. */
async function callJson(name, args = {}, opts = {}) {
  return jsonOf(name, await call(name, args, opts));
}

/** Read a selector's textContent via evaluate in the ISOLATED world. */
async function evalText(tabId, selector) {
  const res = await callJson("evaluate", {
    tabId,
    function: `(args) => { const el = document.querySelector(args.s); return el ? el.textContent : null; }`,
    args: { s: selector },
    world: "ISOLATED"
  });
  return res && typeof res.result === "string" ? res.result : null;
}

/** Snapshot text → ref lookup by element id, falling back to visible text. */
function findRefInSnapshot(snapshotText, { id, text }) {
  for (const line of String(snapshotText).split("\n")) {
    const m = line.match(/\[(\d+)\]/);
    if (!m) continue;
    if (id && line.includes(`id=${id}`)) return Number(m[1]);
    if (text && line.includes(text)) return Number(m[1]); // matches "quoted" listings too
  }
  return null;
}

/** Extract the WebMCP call payload: { ok, result } envelope or bare result. */
function webmcpPayload(parsed) {
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    if (parsed.ok === false) {
      const msg = parsed.error && parsed.error.message ? parsed.error.message : "webmcp tool failed";
      throw new Error(`webmcp error: ${msg}`);
    }
    return parsed.result !== undefined ? parsed.result : parsed;
  }
  return parsed;
}

// ----------------------------------------------------------------- harness

const results = [];
function statusOf(name) {
  const r = results.find((x) => x.name === name);
  return r ? r.status : null;
}
function record(name, status, detail) {
  results.push({ name, status, detail: detail ? String(detail) : "" });
  const line = `${status} ${name}${detail ? ` (${String(detail).slice(0, 300)})` : ""}`;
  if (status === "FAIL") console.error("  " + line);
  else console.log("  " + line);
}
async function step(name, fnOrOpts, maybeFn) {
  const opts = typeof fnOrOpts === "function" ? {} : (fnOrOpts || {});
  const fn = typeof fnOrOpts === "function" ? fnOrOpts : maybeFn;
  const deps = opts.dependsOn || [];
  const blocked = deps.filter((d) => statusOf(d) !== "PASS");
  if (blocked.length) {
    record(name, "SKIP", `blocked by non-passing: ${blocked.join(", ")}`);
    return;
  }
  try {
    const detail = await fn();
    record(name, "PASS", detail);
  } catch (e) {
    record(name, "FAIL", e && e.message ? e.message : String(e));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ------------------------------------------------------------------ cleanup

let chromeProc = null;
let serverProc = null;       // manually-spawned MCP server (stream transport mode)
let stdioTransport = null;   // transport that owns the server (fallback mode)
let demoServer = null;
let cdpWs = null;
const tempDirs = [];
let cleanupRun = null;

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || !child.pid) return resolve();
    if (process.platform === "win32") {
      const t = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      t.once("close", () => resolve());
      t.once("error", () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } resolve(); });
    } else {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve();
    }
  });
}

async function cleanup() {
  if (cleanupRun) return cleanupRun;
  cleanupRun = (async () => {
    try { if (cdpWs) { try { cdpWs.close(); } catch { /* ignore */ } } } catch { /* ignore */ }
    await killTree(chromeProc);
    chromeProc = null;
    try { if (mcpClient) await mcpClient.close(); } catch { /* ignore */ }
    try { if (stdioTransport) await stdioTransport.close(); } catch { /* ignore */ }
    await killTree(serverProc);
    serverProc = null;
    try {
      if (demoServer) {
        demoServer.server.closeAllConnections?.(); // drop keep-alive sockets so close() resolves
        await new Promise((r) => demoServer.server.close(r));
      }
    } catch { /* ignore */ }
    for (const d of tempDirs) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(300); }
      }
    }
    console.log("\n[cleanup] done. Note: the native messaging host remains installed");
    console.log("[cleanup] (it is idempotent). Remove it any time with: npm run uninstall-host");
  })();
  return cleanupRun;
}

// --------------------------------------------------------------------- main

const ctx = { instanceId: null }; // shared state between steps (browser instance, tab ids, refs, item ids)

async function main() {
  console.log("== webmcp-tools E2E ==");
  console.log(`repo root: ${REPO_ROOT}`);

  // 1 — preflight -----------------------------------------------------------
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`MCP server not built: ${SERVER_ENTRY} is missing — run npm run build first`);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Chrome not found (looked in Program Files, Program Files (x86), LOCALAPPDATA and platform paths)");
  }
  console.log(`chrome:    ${chromePath}`);
  const cdpPort = await getFreePort();
  console.log(`cdp port:  ${cdpPort}`);

  // 2 — demo static server --------------------------------------------------
  const demos = await startDemoServer(DEMOS_DIR);
  demoServer = demos;
  const demoBase = `http://127.0.0.1:${demos.port}`;
  console.log(`demos:     ${demoBase}`);

  // 3 — native messaging host ----------------------------------------------
  await installNativeHost((m) => console.log(m));

  // 4 — MCP server over stdio ----------------------------------------------
  // Preferred: spawn manually with piped stderr so server logs are visible,
  // and connect over the child's stdio via StreamClientTransport. Fallback
  // (older SDK): let StdioClientTransport spawn the server with stderr piped.
  let StreamClientTransport = null;
  try {
    ({ StreamClientTransport: StreamClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stream.js"));
  } catch { /* fallback below */ }

  mcpClient = new Client({ name: "webmcp-e2e-harness", version: "0.1.0" }, { capabilities: {} });

  if (StreamClientTransport) {
    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"]
    });
    serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    serverProc.once("exit", (code, signal) => {
      if (!cleanupRun) console.error(`[server] exited prematurely: code=${code} signal=${signal}`);
    });
    const transport = new StreamClientTransport({
      readable: Readable.toWeb(serverProc.stdout),
      writable: Writable.toWeb(serverProc.stdin)
    });
    await mcpClient.connect(transport);
    console.log(`mcp:       client connected (manual spawn, pid ${serverProc.pid})`);
  } else {
    stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      cwd: REPO_ROOT,
      stderr: "pipe"
    });
    stdioTransport.on?.("stderr", (d) => process.stderr.write(`[server] ${d}`));
    await mcpClient.connect(stdioTransport);
    console.log("mcp:       client connected (StdioClientTransport spawn)");
  }

  // 4b — record browsers already connected to the hub (e.g. the user's daily
  //      Chrome with the extension loaded), so we only ever target OUR instance
  const preexistingIds = new Set();
  try {
    const res = await mcpClient.callTool({ name: "get_browser_info", arguments: {} });
    if (res && !res.isError) {
      const p = jsonOf("get_browser_info", res);
      for (const inst of p.instances ?? []) {
        if (inst && inst.instanceId) preexistingIds.add(inst.instanceId);
      }
    }
  } catch { /* no extension connected yet — fine */ }
  if (preexistingIds.size > 0) {
    console.log(`instances:  ${preexistingIds.size} other browser(s) already connected (tests will pin their own instance)`);
  }

  // 5 — launch Chrome (AFTER the hub is listening, so the extension's native
  //     connect lands on a live hub) ----------------------------------------
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "webmcp-e2e-profile-"));
  tempDirs.push(profileDir);
  chromeProc = spawn(chromePath, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { detached: false, stdio: "ignore" });
  chromeProc.once("error", (e) => { if (!cleanupRun) console.error(`[chrome] spawn error: ${e.message}`); });
  console.log(`chrome:    launched pid ${chromeProc.pid} (fresh profile ${profileDir})`);

  // 6 — load the unpacked extension over CDP --------------------------------
  const version = await waitForCdpEndpoint(cdpPort);
  console.log(`cdp:       browser websocket ${version.webSocketDebuggerUrl}`);
  const loaded = await cdpLoadUnpacked(version.webSocketDebuggerUrl, EXTENSION_DIR);
  cdpWs = loaded.ws;
  console.log(`cdp:       extension loaded${loaded.extensionId ? ` (id ${loaded.extensionId})` : ""}`);

  // 7 — wait for OUR extension instance to connect through the whole chain --
  // Other browsers may also be connected (user's daily Chrome). Ours is
  // identified deterministically: a REAL instanceId (the harness build always
  // sends one; stale builds only get synthetic conn-N ids) that is new since
  // the snapshot AND belongs to a browser with a fresh profile (≈1 tab).
  console.log(`waiting up to ${EXTENSION_CONNECT_TIMEOUT_MS / 1000}s for extension ⟶ relay ⟶ hub link...`);
  const connectDeadline = Date.now() + EXTENSION_CONNECT_TIMEOUT_MS;
  const rejectedIds = new Set();
  let info = null;
  let lastConnectErr = "";
  while (Date.now() < connectDeadline) {
    try {
      const res = await mcpClient.callTool({ name: "get_browser_info", arguments: {} });
      if (!res || res.isError) {
        lastConnectErr = res ? textContentOf(res).slice(0, 200) : "empty response";
      } else {
        const p = jsonOf("get_browser_info", res);
        const candidates = (p.instances ?? []).filter(
          (i) =>
            i &&
            i.instanceId &&
            !preexistingIds.has(i.instanceId) &&
            !rejectedIds.has(i.instanceId) &&
            !/^conn-\d+$/.test(i.instanceId)
        );
        let pinned = false;
        for (const cand of candidates) {
          try {
            const tabsRes = await mcpClient.callTool({
              name: "list_tabs",
              arguments: { instanceId: cand.instanceId },
            });
            if (tabsRes && !tabsRes.isError) {
              const tabs = jsonOf("list_tabs", tabsRes).tabs ?? [];
              if (Array.isArray(tabs) && tabs.length <= 2) {
                ctx.instanceId = cand.instanceId;
                info = { ...cand, instances: p.instances };
                pinned = true;
                break;
              }
              rejectedIds.add(cand.instanceId); // busy browser — not ours
            }
          } catch { /* candidate unusable; try the next */ }
        }
        if (pinned) break;
        lastConnectErr =
          "bridge is up, but no fresh browser instance with a real instanceId has registered yet";
      }
    } catch (e) {
      lastConnectErr = e && e.message ? e.message : String(e);
    }
    await sleep(500);
  }
  if (!info) {
    throw new Error(
      `extension did not connect within ${EXTENSION_CONNECT_TIMEOUT_MS / 1000}s (last error: ${lastConnectErr}). ` +
      "Check that the native host is installed (npm run install-host), that server/dist/index.js is fresh, " +
      "and the Chrome extension did not fail to start."
    );
  }
  console.log(`link:      extension connected (instance ${ctx.instanceId}, Chrome ${info.chromeVersion}, platform ${info.platform})`);

  // 8 — test sequence --------------------------------------------------------
  const autoUrl = `${demoBase}/automation-test.html`;
  const navUrl = `${demoBase}/navigation-target.html`;
  const storeUrl = `${demoBase}/webmcp-store/index.html`;
  const formUrl = `${demoBase}/declarative-form.html`;
  console.log("\n== test sequence ==");

  await step("get_browser_info", async () => {
    const p = await callJson("get_browser_info", {});
    assert(p.chromeVersion, "missing chromeVersion");
    return `Chrome ${p.chromeVersion}`;
  });

  await step("list_tabs", async () => {
    const p = await callJson("list_tabs", {});
    assert(Array.isArray(p.tabs) && p.tabs.length >= 1, `expected >=1 tab, got ${p.tabs && p.tabs.length}`);
    return `${p.tabs.length} tab(s)`;
  });

  await step("new_tab automation-test", async () => {
    const p = await callJson("new_tab", { url: autoUrl });
    assert(p.tab && typeof p.tab.tabId === "number", "new_tab returned no tab");
    ctx.autoTabId = p.tab.tabId;
    return `tabId ${p.tab.tabId} ${p.tab.url}`;
  });

  await step("wait_for selector #count-button", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, selector: "#count-button" });
    assert(p.found === true, `found=${p.found}`);
    return p.matched;
  });

  await step("wait_for text 'Click me'", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, text: "Click me" });
    assert(p.found === true, `found=${p.found}`);
    return p.matched;
  });

  await step("wait_for selector #json-data[data-check=ready]", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, selector: "#json-data[data-check='ready']" });
    assert(p.found === true, `found=${p.found}`);
    return "attribute selector matched";
  });

  await step("snapshot", { dependsOn: ["new_tab automation-test"] }, async () => {
    const res = await call("snapshot", { tabId: ctx.autoTabId, maxElements: 400 });
    ctx.snapshotText = textContentOf(res);
    let count = 0;
    try { count = jsonOf("snapshot", res).elements.length; } catch { /* text-format fallback */ }
    ctx.countRef = findRefInSnapshot(ctx.snapshotText, { id: "count-button", text: "Click me" });
    assert(ctx.countRef !== null, `could not find a ref for #count-button in snapshot (elements: ${count})`);
    return `${count} elements, #count-button ref=${ctx.countRef}`;
  });

  await step("click by ref increments counter", { dependsOn: ["snapshot"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, ref: ctx.countRef });
    const n = await evalText(ctx.autoTabId, "#count-display");
    assert(n === "1", `expected #count-display "1", got ${JSON.stringify(n)}`);
    return `#count-display=${n} (ref ${ctx.countRef})`;
  });

  await step("click by selector increments counter", { dependsOn: ["click by ref increments counter"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, selector: "#count-button" });
    const n = await evalText(ctx.autoTabId, "#count-display");
    assert(n === "2", `expected #count-display "2", got ${JSON.stringify(n)}`);
    return `#count-display=${n}`;
  });

  await step("dblclick via clickCount:2", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, selector: "#dbl-button", clickCount: 2 });
    const n = await evalText(ctx.autoTabId, "#dbl-display");
    assert(n === "1", `expected #dbl-display "1", got ${JSON.stringify(n)}`);
    return `#dbl-display=${n}`;
  });

  await step("type_text into #name-input", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("type_text", { tabId: ctx.autoTabId, selector: "#name-input", text: "Ada Lovelace" });
    const p = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => document.querySelector("#name-input").value`,
      args: {}, world: "ISOLATED"
    });
    assert(p.result === "Ada Lovelace", `expected value "Ada Lovelace", got ${JSON.stringify(p.result)}`);
    return `value="${p.result}"`;
  });

  await step("select_option cherry", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("select_option", { tabId: ctx.autoTabId, selector: "#fruit-select", label: "cherry" });
    const out = await evalText(ctx.autoTabId, "#select-output");
    assert(out && out.includes("cherry"), `expected #select-output to contain "cherry", got ${JSON.stringify(out)}`);
    return `selected=${JSON.stringify(p.selected || ["?"])}, #select-output="${out}"`;
  });

  await step("click checkbox #opt-in", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, selector: "#opt-in" });
    const p = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => ({ checked: document.querySelector("#opt-in").checked, status: document.querySelector("#opt-status").textContent })`,
      args: {}, world: "ISOLATED"
    });
    assert(p.result && p.result.checked === true, `checkbox not checked: ${JSON.stringify(p.result)}`);
    assert(p.result.status.trim() === "checked", `#opt-status expected "checked", got ${JSON.stringify(p.result.status)}`);
    return "#opt-in checked, #opt-status=checked";
  });

  await step("form submit via #form-submit", { dependsOn: ["type_text into #name-input", "select_option cherry"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, selector: "#form-submit" });
    const out = await evalText(ctx.autoTabId, "#form-output");
    assert(out && out.includes("Ada Lovelace"), `#form-output missing name: ${JSON.stringify(out)}`);
    return `#form-output="${out}"`;
  });

  await step("press_key Control+A", { dependsOn: ["type_text into #name-input"] }, async () => {
    const p = await callJson("press_key", { tabId: ctx.autoTabId, selector: "#name-input", key: "Control+A" });
    assert(p.pressed === true, `pressed=${p.pressed}`);
    return "pressed";
  });

  await step("type_text replaces selection", { dependsOn: ["press_key Control+A"] }, async () => {
    await call("type_text", { tabId: ctx.autoTabId, selector: "#name-input", text: "Grace Hopper", clearFirst: false });
    const p = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => document.querySelector("#name-input").value`,
      args: {}, world: "ISOLATED"
    });
    assert(String(p.result).includes("Grace Hopper"), `expected value to contain "Grace Hopper", got ${JSON.stringify(p.result)}`);
    return `value="${p.result}"`;
  });

  await step("press_key Enter submits form", { dependsOn: ["type_text replaces selection"] }, async () => {
    await call("press_key", { tabId: ctx.autoTabId, selector: "#name-input", key: "Enter" });
    const out = await evalText(ctx.autoTabId, "#form-output");
    assert(out && out.includes("Grace Hopper"), `#form-output missing "Grace Hopper": ${JSON.stringify(out)}`);
    return `#form-output="${out}"`;
  });

  await step("hover #hover-target", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("hover", { tabId: ctx.autoTabId, selector: "#hover-target" });
    const state = await evalText(ctx.autoTabId, "#hover-state");
    const target = await evalText(ctx.autoTabId, "#hover-target");
    assert(state === "Hovered!", `#hover-state expected "Hovered!", got ${JSON.stringify(state)}`);
    assert(target === "Hovered!", `#hover-target expected "Hovered!", got ${JSON.stringify(target)}`);
    return "#hover-state=Hovered!";
  });

  await step("scroll down 2000", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("scroll", { tabId: ctx.autoTabId, direction: "down", amount: 2000 });
    const p = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => window.scrollY`,
      args: {}, world: "ISOLATED"
    });
    assert(Number(p.result) > 0, `expected scrollY > 0, got ${JSON.stringify(p.result)}`);
    return `scrollY=${p.result}`;
  });

  await step("wait_for #bottom-marker", { dependsOn: ["scroll down 2000"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, selector: "#bottom-marker", timeoutMs: 15000 });
    assert(p.found === true, `found=${p.found}`);
    return "BOTTOM reached";
  });

  await step("trusted click", { dependsOn: ["new_tab automation-test"] }, async () => {
    const before = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => document.querySelector("#count-display").textContent`,
      args: {}, world: "ISOLATED"
    });
    await call("click", { tabId: ctx.autoTabId, selector: "#count-button", trusted: true, timeoutMs: 15000 });
    const after = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => document.querySelector("#count-display").textContent`,
      args: {}, world: "ISOLATED"
    });
    assert(Number(after.result) === Number(before.result) + 1, `trusted click did not increment (${before.result} → ${after.result})`);
    return `count ${before.result} → ${after.result} via CDP Input`;
  });

  await step("trusted type_text", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("type_text", { tabId: ctx.autoTabId, selector: "#name-input", text: "Trusted", clearFirst: true, trusted: true, timeoutMs: 15000 });
    const p = await callJson("evaluate", {
      tabId: ctx.autoTabId,
      function: `(args) => document.querySelector("#name-input").value`,
      args: {}, world: "ISOLATED"
    });
    assert(p.result === "Trusted", `expected "Trusted", got ${JSON.stringify(p.result)}`);
    return `value="${p.result}" via CDP Input`;
  });

  await step("screenshot png", { dependsOn: ["new_tab automation-test"] }, async () => {
    const res = await call("screenshot", { tabId: ctx.autoTabId, format: "png" });
    const img = imageContentOf(res);
    assert(img && typeof img.data === "string", "no MCP image content returned");
    assert(img.data.length > 1000, `base64 payload too small: ${img.data.length}`);
    assert((img.mimeType || "").includes("image/"), `unexpected mimeType ${img.mimeType}`);
    return `${img.mimeType}, ${img.data.length} base64 chars`;
  });

  await step("screenshot jpeg fullPage", { dependsOn: ["new_tab automation-test"] }, async () => {
    const res = await call("screenshot", { tabId: ctx.autoTabId, format: "jpeg", fullPage: true });
    const img = imageContentOf(res);
    assert(img && typeof img.data === "string" && img.data.length > 1000, "no/short MCP image content returned");
    assert((img.mimeType || "") === "image/jpeg", `unexpected mimeType ${img.mimeType}`);
    return `image/jpeg, ${img.data.length} base64 chars`;
  });

  await step("get_page_text", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("get_page_text", { tabId: ctx.autoTabId });
    assert(String(p.text || "").includes("Click me"), "page text missing 'Click me'");
    return `${String(p.text || "").length} chars`;
  });

  await step("get_links", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("get_links", { tabId: ctx.autoTabId });
    const links = Array.isArray(p.links) ? p.links : [];
    assert(links.some((l) => String(l.href || "").includes("navigation-target.html")), "no link to navigation-target.html");
    return `${links.length} link(s), found navigation-target.html`;
  });

  await step("click #log-button", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("click", { tabId: ctx.autoTabId, selector: "#log-button" });
    return "clicked";
  });

  await step("get_console_logs has error", { dependsOn: ["click #log-button"] }, async () => {
    // console entries hop MAIN hook -> postMessage -> content script -> SW buffer;
    // give the pipeline a moment before reading.
    await new Promise((r) => setTimeout(r, 500));
    const p = await callJson("get_console_logs", { tabId: ctx.autoTabId });
    const logs = Array.isArray(p.logs) ? p.logs : [];
    const err = logs.find((l) => l && l.level === "error" && String(l.text || "").includes("test-error"));
    assert(err, `no level=error entry containing "test-error" among ${logs.length} log(s)`);
    return `${logs.length} log(s), error entry present`;
  });

  await step("get_cookies reads page cookie", { dependsOn: ["new_tab automation-test"] }, async () => {
    await call("evaluate", {
      tabId: ctx.autoTabId,
      function: "(args) => { document.cookie = 'webmcp_e2e=ok; path=/'; return document.cookie.includes('webmcp_e2e'); }",
      world: "MAIN",
    });
    const p = await callJson("get_cookies", { tabId: ctx.autoTabId });
    const c = (p.cookies ?? []).find((x) => x.name === "webmcp_e2e");
    assert(c && c.value === "ok", `webmcp_e2e not found among ${(p.cookies ?? []).length} cookie(s)`);
    return `${(p.cookies ?? []).length} cookie(s), webmcp_e2e=ok via CDP`;
  });

  await step("navigate to navigation-target", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("navigate", { tabId: ctx.autoTabId, url: navUrl });
    assert(String(p.url || "").includes("navigation-target.html"), `unexpected url ${p.url}`);
    return p.title || p.url;
  });

  await step("wait_for 'Navigation Target'", { dependsOn: ["navigate to navigation-target"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, text: "Navigation Target" });
    assert(p.found === true, `found=${p.found}`);
    return p.matched;
  });

  await step("go_back returns to automation-test", { dependsOn: ["navigate to navigation-target"] }, async () => {
    await callJson("go_back", { tabId: ctx.autoTabId });
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, text: "Click me" });
    assert(p.found === true, `"Click me" not found after go_back (found=${p.found})`);
    return "back on automation-test";
  });

  await step("reload", { dependsOn: ["go_back returns to automation-test"] }, async () => {
    await callJson("reload", { tabId: ctx.autoTabId });
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, text: "Click me" });
    assert(p.found === true, `"Click me" not found after reload (found=${p.found})`);
    return "reloaded";
  });

  await step("go_forward returns to navigation-target", { dependsOn: ["go_back returns to automation-test"] }, async () => {
    await callJson("go_forward", { tabId: ctx.autoTabId });
    const p = await callJson("wait_for", { tabId: ctx.autoTabId, text: "Navigation Target" });
    assert(p.found === true, `"Navigation Target" not found after go_forward (found=${p.found})`);
    return "forward on navigation-target";
  });

  await step("get_network_requests enables capture", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("get_network_requests", { tabId: ctx.autoTabId });
    ctx.networkFirstCount = Array.isArray(p.requests) ? p.requests.length : 0;
    return `capture attached, ${ctx.networkFirstCount} request(s) buffered`;
  });

  await step("get_network_requests sees 200s", { dependsOn: ["get_network_requests enables capture"] }, async () => {
    if (ctx.networkFirstCount > 0) {
      return `already captured ${ctx.networkFirstCount} request(s) before re-navigation`;
    }
    await callJson("navigate", { tabId: ctx.autoTabId, url: autoUrl });
    await callJson("wait_for", { tabId: ctx.autoTabId, selector: "#count-button" });
    const p = await callJson("get_network_requests", { tabId: ctx.autoTabId });
    const requests = Array.isArray(p.requests) ? p.requests : [];
    const ok = requests.filter((r) => r && r.status === 200);
    assert(ok.length >= 1, `no status-200 requests among ${requests.length}`);
    return `${ok.length} request(s) with status 200`;
  });

  await step("stop_network_capture", { dependsOn: ["get_network_requests sees 200s"] }, async () => {
    const p = await callJson("stop_network_capture", { tabId: ctx.autoTabId });
    assert(p.stopped === true, `stopped=${p.stopped}`);
    return `capture detached on tabId ${ctx.autoTabId}`;
  });

  // --- WebMCP: imperative store page ---------------------------------------

  await step("new_tab webmcp-store", async () => {
    const p = await callJson("new_tab", { url: storeUrl });
    assert(p.tab && typeof p.tab.tabId === "number", "new_tab returned no tab");
    ctx.storeTabId = p.tab.tabId;
    return `tabId ${p.tab.tabId}`;
  });

  await step("wait_for store #results", { dependsOn: ["new_tab webmcp-store"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.storeTabId, selector: "#results" });
    assert(p.found === true, `found=${p.found}`);
    return p.matched;
  });

  await step("list_webmcp_tools (store)", { dependsOn: ["new_tab webmcp-store"] }, async () => {
    const p = await callJson("list_webmcp_tools", { tabId: ctx.storeTabId });
    const names = (p.tools || []).map((t) => t.name);
    assert(p.supported === true, `supported=${p.supported}`);
    assert(p.mode === "native" || p.mode === "polyfill", `unexpected mode ${JSON.stringify(p.mode)}`);
    for (const n of ["search_catalog", "add_to_cart", "get_cart"]) {
      assert(names.includes(n), `tools missing ${n}: [${names.join(", ")}]`);
    }
    return `mode=${p.mode}, ${names.length} tool(s)`;
  });

  await step("webmcp search_catalog espresso", { dependsOn: ["list_webmcp_tools (store)"] }, async () => {
    const p = webmcpPayload(await callJson("call_webmcp_tool", {
      tabId: ctx.storeTabId, name: "search_catalog", args: { query: "espresso" }
    }));
    const results = (p && p.results) || [];
    assert(results.length >= 1, `expected >=1 result, got ${results.length}`);
    assert(results[0] && typeof results[0].id === "string" && results[0].id, "first result has no id");
    ctx.firstItemId = results[0].id;
    return `${results.length} result(s), first=${results[0].id}`;
  });

  await step("webmcp add_to_cart x2", { dependsOn: ["webmcp search_catalog espresso"] }, async () => {
    const p = webmcpPayload(await callJson("call_webmcp_tool", {
      tabId: ctx.storeTabId, name: "add_to_cart", args: { item_id: ctx.firstItemId, quantity: 2 }
    }));
    assert(p && p.cart_size === 2, `expected cart_size 2, got ${JSON.stringify(p)}`);
    return `cart_size=${p.cart_size}`;
  });

  await step("webmcp get_cart total", { dependsOn: ["webmcp add_to_cart x2"] }, async () => {
    const p = webmcpPayload(await callJson("call_webmcp_tool", {
      tabId: ctx.storeTabId, name: "get_cart", args: {}
    }));
    assert(p && Array.isArray(p.items) && p.items.length >= 1, "cart has no items");
    assert(Number(p.total) > 0, `expected total > 0, got ${JSON.stringify(p.total)}`);
    return `${p.items.length} line item(s), total=${p.total}`;
  });

  await step("store UI reflects tool calls", { dependsOn: ["webmcp add_to_cart x2"] }, async () => {
    const p = await callJson("evaluate", {
      tabId: ctx.storeTabId,
      function: `(args) => ({ size: document.querySelector("#cart-size").textContent, total: document.querySelector("#cart-total").textContent })`,
      args: {}, world: "ISOLATED"
    });
    assert(p.result && String(p.result.size).trim() === "2", `#cart-size expected "2", got ${JSON.stringify(p.result)}`);
    assert(p.result && String(p.result.total || "").trim() !== "", "#cart-total empty");
    return `#cart-size=${p.result.size}, #cart-total=${p.result.total}`;
  });

  await step("snapshot store page", { dependsOn: ["wait_for store #results"] }, async () => {
    const res = await call("snapshot", { tabId: ctx.storeTabId, maxElements: 300 });
    const text = textContentOf(res);
    let count = 0;
    try { count = jsonOf("snapshot", res).elements.length; } catch { /* text-format fallback */ }
    assert(/button/i.test(text), "snapshot shows no buttons");
    return `${count} elements`;
  });

  // --- WebMCP: declarative form page ---------------------------------------

  await step("new_tab declarative-form", async () => {
    const p = await callJson("new_tab", { url: formUrl });
    assert(p.tab && typeof p.tab.tabId === "number", "new_tab returned no tab");
    ctx.formTabId = p.tab.tabId;
    return `tabId ${p.tab.tabId}`;
  });

  await step("wait_for #reserve-form", { dependsOn: ["new_tab declarative-form"] }, async () => {
    const p = await callJson("wait_for", { tabId: ctx.formTabId, selector: "#reserve-form" });
    assert(p.found === true, `found=${p.found}`);
    return p.matched;
  });

  await step("list_webmcp_tools (declarative)", { dependsOn: ["new_tab declarative-form"] }, async () => {
    const p = await callJson("list_webmcp_tools", { tabId: ctx.formTabId });
    const names = (p.tools || []).map((t) => t.name);
    assert(names.includes("reserve_table"), `tools missing reserve_table: [${names.join(", ")}]`);
    return `mode=${p.mode}, tools=[${names.join(", ")}]`;
  });

  await step("webmcp reserve_table", { dependsOn: ["list_webmcp_tools (declarative)"] }, async () => {
    await callJson("call_webmcp_tool", {
      tabId: ctx.formTabId, name: "reserve_table",
      args: { name: "Grace", guests: 4, time: "19:00" }
    });
    const out = await evalText(ctx.formTabId, "#result");
    assert(out && out.includes("Grace") && out.includes("Reserved"), `#result wrong: ${JSON.stringify(out)}`);
    return `#result="${out}"`;
  });

  // --- WebMCP: injectPolyfill on a plain page -------------------------------

  await step("list_webmcp_tools injectPolyfill on plain page", { dependsOn: ["new_tab automation-test"] }, async () => {
    const p = await callJson("list_webmcp_tools", { tabId: ctx.autoTabId, injectPolyfill: true });
    if (p.supported === true) {
      assert(p.mode === "polyfill", `expected mode "polyfill" after injection, got ${JSON.stringify(p.mode)}`);
      return `supported=true mode=${p.mode}`;
    }
    const tools = Array.isArray(p.tools) ? p.tools : [];
    assert(tools.length === 0, `plain page unexpectedly exposes tools: ${tools.map((t) => t.name).join(", ")}`);
    return `supported=${p.supported} mode=${p.mode}, tools=[]`;
  });

  await step("evaluate MAIN world sees window.__store", { dependsOn: ["new_tab webmcp-store"] }, async () => {
    const p = await callJson("evaluate", {
      tabId: ctx.storeTabId,
      function: `(args) => ({ v: window.__store ? window.__store.catalog.length : 0, v2: 1 + 1 })`,
      args: {}, world: "MAIN"
    });
    assert(p.result && p.result.v2 === 2, `v2 expected 2, got ${JSON.stringify(p.result)}`);
    assert(p.result && Number(p.result.v) > 0, `expected catalog length > 0, got ${JSON.stringify(p.result)}`);
    return `catalog=${p.result.v}, v2=${p.result.v2}`;
  });

  // --- tab management -------------------------------------------------------

  await step("close_tab", { dependsOn: ["new_tab declarative-form"] }, async () => {
    const p = await callJson("close_tab", { tabId: ctx.formTabId });
    assert(p.closed === true, `closed=${p.closed}`);
    return `closed tabId ${ctx.formTabId}`;
  });

  await step("activate_tab", { dependsOn: ["new_tab webmcp-store"] }, async () => {
    const p = await callJson("activate_tab", { tabId: ctx.storeTabId });
    assert(p.tab && p.tab.tabId === ctx.storeTabId, `unexpected tab ${JSON.stringify(p.tab && p.tab.tabId)}`);
    assert(p.tab.active === true, "tab not active after activate_tab");
    return `tabId ${ctx.storeTabId} active`;
  });

  await step("list_tabs final sanity", { dependsOn: ["close_tab", "activate_tab"] }, async () => {
    const p = await callJson("list_tabs", {});
    const tabs = Array.isArray(p.tabs) ? p.tabs : [];
    assert(!tabs.some((t) => t.tabId === ctx.formTabId), "closed tab still listed");
    assert(tabs.some((t) => t.tabId === ctx.storeTabId && t.active === true), "store tab not present/active");
    return `${tabs.length} tab(s), form tab gone, store tab active`;
  });

  // 9 — summary --------------------------------------------------------------
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n== summary: PASSED ${passed} / FAILED ${failed.length}` + (skipped ? ` / SKIPPED ${skipped}` : "") + " ==");
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- watchdog

let watchdogFired = false;
const watchdog = setTimeout(async () => {
  watchdogFired = true;
  console.error(`\n[watchdog] E2E exceeded ${WATCHDOG_MS / 1000}s — aborting.`);
  results.push({ name: "watchdog", status: "FAIL", detail: `exceeded ${WATCHDOG_MS / 1000}s` });
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(1);
}, WATCHDOG_MS);

// -------------------------------------------------------------------- run

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error(`\nFATAL: ${e && e.stack ? e.stack : e}`);
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { await cleanup(); } catch (e) { console.error(`[cleanup] error: ${e && e.message ? e.message : e}`); }
}
if (watchdogFired) process.exit(1);
process.exit(exitCode);
