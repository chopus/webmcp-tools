#!/usr/bin/env node
/**
 * One-shot Instagram user-pk scraper — straight MCP client against our own
 * webmcp-browser server, the same tools/call loop an LLM agent would run:
 *
 *   node examples/ig-pks.mjs forumwasit.idn garudacultur …
 *
 * Approach: ONE tab is navigated to https://www.instagram.com/ once; each
 * profile is then a single `evaluate` that fetches /api/v1/users/web_profile_info
 * in page context (flows/lib/ig-pk.js) — the tab's logged-in cookies ride
 * along, exactly like the page's own hydration XHR. No debugger attach, no
 * response-body capture needed: 1 navigate + N evaluates total.
 *
 * Output: one line per profile, then a JSON map { username: pk }.
 * Exit code 0 only when every profile yielded a pk.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const users = process.argv.slice(2);
if (users.length === 0) {
  console.error("usage: node examples/ig-pks.mjs <username>…");
  process.exit(2);
}

// The fetcher file is one function expression — evaluate runs it verbatim.
const fetcher = readFileSync(join(root, "flows", "lib", "ig-pk.js"), "utf8");

const client = new Client({ name: "ig-pks", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "server", "dist", "index.js")],
}));

const callJson = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const text = r.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// This script spawns a FRESH server: the extension may still be in its
// reconnect backoff from the previous run's shutdown. Poll for it.
let info = null;
for (let i = 0; i < 60 && !info; i++) {
  try { info = await callJson("get_browser_info"); } catch { await sleep(1000); }
}
if (!info) {
  throw new Error("extension did not connect within 60s — reload it in chrome://extensions (v0.2.1+ self-heals)");
}
console.log(`browser: Chrome ${info.chromeVersion} via extension ${info.extensionVersion}`);

const tab = (await callJson("new_tab", { url: "https://www.instagram.com/", active: false })).tab;

const fetchPk = async (user) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = (await callJson("evaluate", {
        tabId: tab.tabId,
        world: "MAIN",
        function: fetcher,
        args: { username: user },
      })).result;
      if (data.reason === "rate_limited") {
        lastErr = new Error("rate_limited");
        await sleep(5000); // long backoff, then retry
        continue;
      }
      return { user, ...data };
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500);
  }
  return { user, ok: false, reason: String(lastErr?.message || lastErr) };
};

const results = [];
try {
  for (const user of users) {
    const r = await fetchPk(user);
    results.push(r);
    console.log(
      r.ok
        ? `${user.padEnd(28)} pk=${r.pk}  followers=${r.followers}${r.isPrivate ? "  PRIVATE" : ""}${r.isVerified ? "  verified" : ""}`
        : `${user.padEnd(28)} FAILED: ${r.reason}`,
    );
    await sleep(900); // stay at a human API-call pace
  }
} finally {
  await callJson("close_tab", { tabId: tab.tabId }).catch(() => {});
  await client.close().catch(() => {});
}

const ok = Object.fromEntries(
  results.filter((r) => r.ok && r.pk).map((r) => [r.user, r.pk]),
);
const failed = results.filter((r) => !(r.ok && r.pk)).map((r) => r.user);
console.log(`\n${JSON.stringify(ok, null, 2)}`);
console.log(`\n${Object.keys(ok).length}/${results.length} succeeded${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
