#!/usr/bin/env node
/**
 * Automation service: REST API in, real-Chrome Google search, response out.
 *
 *   npm run api                          # serves http://localhost:8787
 *
 *   # the API you asked for — POST a search:
 *   curl -X POST http://localhost:8787/search \
 *        -H 'content-type: application/json' \
 *        -d '{"query":"capybara","pages":2}'
 *
 *   # browser demo: open http://localhost:8787 — a form that POSTs and
 *   # renders the results page ("shows the response")
 *
 * POST /search body: { query, pages?=1, instanceId?, keepTab?=false, screenshot?=false }
 *   → JSON { ok, query, pages:[{ page, url, results:[{title,url}] }], … }
 *   → HTML when the client accepts text/html (e.g. the form)
 * GET  /search?query=…&pages=…   convenience for browser demos
 * GET  /health                   extension connectivity check
 *
 * Keeps ONE MCP server process alive and shares it across requests; searches
 * run sequentially (FIFO) so concurrent requests can't race each other's tabs.
 */
import { writeFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const TOOL_TIMEOUT = Number(process.env.TOOL_TIMEOUT || 120000);

// ---------------------------------------------------------------- MCP session

const client = new Client({ name: "webmcp-search-api", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "server", "dist", "index.js")],
}));

const callText = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT });
  const text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (r.isError) {
    const e = new Error(text.slice(0, 400));
    if (/extension_not_connected/.test(text)) e.status = 503;
    throw e;
  }
  return text;
};
const callJson = async (name, args = {}) => {
  const text = await callText(name, args);
  const marker = text.indexOf("--- JSON ---"); // snapshot returns lines + JSON
  return JSON.parse(marker >= 0 ? text.slice(marker + 11).trim() : text);
};

let cachedInstance = null;
async function resolveInstance(requested) {
  if (requested) return requested;
  if (cachedInstance) return cachedInstance;
  for (let i = 0; i < 60; i++) {
    try {
      const p = await callJson("get_browser_info");
      const inst = (p.instances ?? [])[0]?.instanceId;
      if (inst) { cachedInstance = inst; return inst; }
    } catch { /* extension not connected yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Object.assign(new Error("no browser connected within 60s — is the extension loaded?"), { status: 503 });
}

// ------------------------------------------------------------- search runner

/** Sequential FIFO so concurrent requests can't race each other's tabs. */
let queue = Promise.resolve();
const enqueue = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function runSearch({ query, pages = 1, instanceId, keepTab = false, screenshot = false }) {
  const t0 = Date.now();
  const inst = await resolveInstance(instanceId);
  const A = (args) => ({ ...args, instanceId: inst });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const { tab } = await callJson("new_tab", A({
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    active: true,
  }));
  const tabId = tab.tabId;
  const outPages = [];

  try {
    for (let page = 0; page < pages; page++) {
      if (page > 0) {
        let advanced = false;
        try { // prefer clicking the real "Next" control (URL fallback below)
          const snap = await callJson("snapshot", A({ tabId }));
          const next = (snap.elements ?? []).find((e) =>
            (e.text && /next/i.test(e.text)) ||
            (e.ariaLabel && /next page/i.test(e.ariaLabel)) ||
            e.id === "pnnext");
          if (next) {
            await callJson("click", A({ tabId, ref: next.ref }));
            advanced = true;
          }
        } catch { /* fall through */ }
        if (!advanced) {
          await callJson("navigate", A({
            tabId,
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${page * 10}`,
          }));
        }
      }

      await callJson("wait_for", A({ tabId, text: query, timeoutMs: 20000 }));
      const info = await callJson("evaluate", A({
        tabId,
        function: `(args) => ({ url: location.href,
          consent: location.href.includes("consent.google.com"),
          results: Array.from(document.querySelectorAll("a h3")).slice(0, 8)
            .map((h) => ({ title: h.innerText.trim(), url: h.closest("a")?.href ?? null })) })`,
        world: "MAIN",
      }));
      if (info.result?.consent) {
        throw Object.assign(new Error("Google is showing a consent page — accept it once manually in that tab"), { status: 502 });
      }
      outPages.push({ page: page + 1, url: info.result.url, results: info.result.results });
    }

    let screenshotDataUrl = null;
    if (screenshot) {
      const shot = await client.callTool(
        { name: "screenshot", arguments: A({ tabId, format: "jpeg", quality: 75, maxWidth: 1200 }) },
        undefined, { timeout: TOOL_TIMEOUT },
      );
      const img = shot.content?.find((c) => c.type === "image");
      if (img?.data) screenshotDataUrl = `data:image/jpeg;base64,${img.data}`;
    }

    return {
      ok: true, query, pages: outPages, instanceId: inst, tabId,
      keptOpen: !!keepTab, screenshotDataUrl,
      durationMs: Date.now() - t0,
    };
  } finally {
    if (!keepTab) {
      try { await callJson("close_tab", A({ tabId })); } catch { /* tab may be gone */ }
    }
  }
}

// ------------------------------------------------------------------- API

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const renderHtml = (r) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.query)} — webmcp search</title>
<style>body{font:15px/1.5 system-ui;margin:2rem auto;max-width:46rem;padding:0 1rem}
h1 a{color:#1a73e8;text-decoration:none}ol{padding-left:1.2rem}li{margin:.6rem 0}
.meta{color:#5f6368;font-size:.85rem}img{max-width:100%;border:1px solid #ddd;border-radius:8px;margin-top:1rem}</style></head><body>
<h1>🔎 <a href="https://www.google.com/search?q=${encodeURIComponent(r.query)}" target="_blank">${esc(r.query)}</a></h1>
<p class="meta">searched in your real Chrome (instance ${esc(r.instanceId)}, tab ${r.tabId}) in ${r.durationMs} ms</p>
${r.pages.map((p) => `<h2>Page ${p.page}</h2><ol>${p.results.map((x) =>
  `<li><a href="${esc(x.url)}" target="_blank">${esc(x.title)}</a><br><span class="meta">${esc(x.url)}</span></li>`).join("")}</ol>`).join("")}
${r.screenshotDataUrl ? `<h2>Screenshot</h2><img src="${r.screenshotDataUrl}" alt="search page">` : ""}
</body></html>`;

const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>webmcp search API</title>
<style>body{font:15px/1.5 system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem}
input,button{font:inherit;padding:.45rem .7rem}input[type=text]{width:60%}button{cursor:pointer}</style></head><body>
<h1>🔎 webmcp search</h1>
<p>POSTs to <code>/search</code> and drives your real Chrome via MCP.</p>
<form method="post" action="/search">
<input name="query" type="text" placeholder="search query" required>
<input name="pages" type="number" min="1" max="5" value="1" title="pages">
<button type="submit">Search in my Chrome</button>
</form></body></html>`;

const app = new Hono();

app.get("/", (c) => c.html(indexHtml));

app.get("/health", async (c) => {
  try {
    const p = await callJson("get_browser_info");
    return c.json({ ok: true, instances: p.instances ?? [], chromeVersion: p.chromeVersion });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 503);
  }
});

const parseInput = (query, body) => {
  const q = typeof body?.query === "string" ? body.query.trim()
    : typeof query === "string" ? query.trim() : "";
  if (!q) return null;
  const num = (v, d, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : d;
  };
  return {
    query: q,
    pages: num(body?.pages ?? query, 1, 5),
    instanceId: typeof body?.instanceId === "string" ? body.instanceId : undefined,
    keepTab: body?.keepTab === true || String(query?.keepTab) === "true",
    screenshot: body?.screenshot === true || String(query?.screenshot) === "true",
  };
};

const wantsHtml = (c) => String(c.req.header("Accept") ?? "").includes("text/html");

app.post("/search", async (c) => {
  const input = parseInput(c.req.query(), await c.req.json().catch(() => ({})));
  if (!input) return c.json({ ok: false, error: "body must be { \"query\": \"…\" }" }, 400);
  try {
    const result = await enqueue(() => runSearch(input));
    if (input.screenshot && result.screenshotDataUrl) {
      // also drop a copy on disk for easy inspection
      try {
        writeFileSync(join(root, ".tmp", `api-${input.query.replace(/\W+/g, "-")}.jpg`),
          Buffer.from(result.screenshotDataUrl.split(",")[1], "base64"));
      } catch { /* best effort */ }
    }
    return wantsHtml(c) ? c.html(renderHtml(result)) : c.json(result);
  } catch (e) {
    const status = e.status ?? 500;
    const body = { ok: false, error: e.message };
    return wantsHtml(c) ? c.html(`<!doctype html><meta charset="utf-8"><body><h1>Search failed</h1><pre>${esc(e.message)}</pre><p><a href="/">back</a></p>`, status) : c.json(body, status);
  }
});

// convenience for browser demos: GET /search?query=capybara&pages=2
app.get("/search", (c) => {
  const input = parseInput(c.req.query(), null);
  if (!input) return c.json({ ok: false, error: "query parameter required" }, 400);
  return app.fetch(new Request("http://local/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: c.req.header("Accept") ?? "application/json" },
    body: JSON.stringify(input),
  }));
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`webmcp search API listening on http://localhost:${info.port}`);
  console.log(`  POST /search  {"query":"capybara","pages":2,"screenshot":true}`);
  console.log(`  GET  /health | GET  / (form demo)`);
});
