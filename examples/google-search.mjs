#!/usr/bin/env node
/**
 * Example: run a Google search in YOUR real Chrome and walk the result pages.
 *
 *   node examples/google-search.mjs               # "capybara", 2 pages
 *   node examples/google-search.mjs "axolotl" 3   # any query, N pages
 *
 * Demonstrates: new_tab, wait_for, evaluate (MAIN world), snapshot + click by
 * ref, navigate fallback, screenshot. The tab is left open in your browser.
 * Requires the extension to be loaded and the native host installed
 * (npm run install-host) — see docs/USAGE.md.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const query = process.argv[2] || "capybara";
const pages = Math.max(1, Number(process.argv[3]) || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "server", "dist", "index.js")],
});
const client = new Client({ name: "webmcp-example", version: "0.0.0" });
await client.connect(transport);

const callText = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (r.isError) throw new Error(text.slice(0, 300));
  return text;
};
// Most tools return pretty JSON; snapshot returns "readable lines --- JSON --- {...}".
const callJson = async (name, args = {}) => {
  const text = await callText(name, args);
  const marker = text.indexOf("--- JSON ---");
  return JSON.parse(marker >= 0 ? text.slice(marker + 11).trim() : text);
};

// Wait for a browser instance and pin it (works with several connected).
let inst = null;
for (let i = 0; i < 60 && !inst; i++) {
  try {
    const p = await callJson("get_browser_info");
    inst = (p.instances ?? [])[0]?.instanceId ?? null;
  } catch { /* extension not connected yet */ }
  if (!inst) await sleep(1000);
}
if (!inst) throw new Error("no browser connected within 60s — is the extension loaded?");
console.log(`browser connected (instance ${inst})`);
const A = (args) => ({ ...args, instanceId: inst });

const { tab } = await callJson("new_tab", A({
  url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  active: true,
}));
console.log(`new tab ${tab.tabId} — google.com/search?q=${query}`);

for (let page = 0; page < pages; page++) {
  if (page > 0) {
    // Prefer clicking the real "Next" control; fall back to the URL.
    let advanced = false;
    try {
      const snap = await callJson("snapshot", A({ tabId: tab.tabId }));
      const next = (snap.elements ?? []).find((e) =>
        (e.text && /next/i.test(e.text)) ||
        (e.ariaLabel && /next page/i.test(e.ariaLabel)) ||
        e.id === "pnnext");
      if (next) {
        await callJson("click", A({ tabId: tab.tabId, ref: next.ref }));
        advanced = true;
        console.log(`clicked "Next" (ref ${next.ref})`);
      }
    } catch { /* fall through to URL navigation */ }
    if (!advanced) {
      await callJson("navigate", A({
        tabId: tab.tabId,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${page * 10}`,
      }));
      console.log(`navigated to page ${page + 1} via URL`);
    }
  }

  await callJson("wait_for", A({ tabId: tab.tabId, text: query, timeoutMs: 20000 }));
  const info = await callJson("evaluate", A({
    tabId: tab.tabId,
    function: `(args) => ({ page: location.search.match(/start=(\d+)/)?.[1] ?? "1",
      titles: Array.from(document.querySelectorAll('h3')).slice(0, 5).map(h => h.innerText.trim()) })`,
    world: "MAIN",
  }));
  console.log(`\nPAGE ${page + 1} top results:`);
  for (const t of info.result.titles ?? []) console.log(`  - ${t}`);
}

const shot = await client.callTool(
  { name: "screenshot", arguments: A({ tabId: tab.tabId, format: "jpeg", quality: 80 }) },
  undefined,
  { timeout: 120000 },
);
const img = shot.content?.find((c) => c.type === "image");
if (img?.data) {
  const out = join(root, ".tmp", `${query}-last-page.jpg`);
  writeFileSync(out, Buffer.from(img.data, "base64"));
  console.log(`\nscreenshot saved: ${out}`);
}
console.log("done — the tab is left open in your browser.");
process.exit(0);
