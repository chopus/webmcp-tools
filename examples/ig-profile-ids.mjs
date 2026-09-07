#!/usr/bin/env node
/**
 * One-shot Instagram profile-id scraper — straight MCP client against our own
 * webmcp-browser server, the same tools/call loop an LLM agent would run:
 *
 *   node examples/ig-profile-ids.mjs highlightimnas infosepakbola.id …
 *
 * Approach (deliberately the cheap one): navigate ONE reused tab to each
 * profile and regex the server-rendered HTML for "profile_id":"<id>" and
 * "pk":"<id>" (extractor: flows/lib/ig-profile.js, sent verbatim as the
 * `function` of a single evaluate call). No debugger attach, no response
 * bodies, no screenshots — one navigate + one evaluate per profile.
 *
 * Output: one line per profile, then a JSON map { username: profile_id }.
 * Exit code 0 only when every profile yielded an id.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const users = process.argv.slice(2);
if (users.length === 0) {
  console.error("usage: node examples/ig-profile-ids.mjs <username>…");
  process.exit(2);
}

// The extractor file is one function expression — evaluate runs it verbatim.
const extractor = readFileSync(join(root, "flows", "lib", "ig-profile.js"), "utf8");

const client = new Client({ name: "ig-profile-ids", version: "0.1.0" });
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

const tab = (await callJson("new_tab", { url: "about:blank", active: false })).tab;

const scrapeOne = async (user) => {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await callJson("navigate", {
        tabId: tab.tabId,
        url: `https://www.instagram.com/${user}/`,
      });
      const data = (await callJson("evaluate", {
        tabId: tab.tabId,
        world: "MAIN",
        function: extractor,
      })).result;
      if (data.loginWall) return { user, error: "login_wall", url: data.url };
      if (data.notFound) return { user, error: "not_found (dead handle)", url: data.url };
      if (data.profileId.value) return { user, ...data };
      lastErr = new Error(`no profile_id in HTML (${data.htmlLength} bytes)`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500); // retry backoff, also softens request bursts
  }
  return { user, error: String(lastErr?.message || lastErr) };
};

const results = [];
try {
  for (const user of users) {
    const r = await scrapeOne(user);
    results.push(r);
    const id = r.profileId?.value;
    const pkInHtml = r.pk?.quoted.total ?? 0;
    console.log(
      id
        ? `${user.padEnd(28)} profile_id=${id}  (also ${pkInHtml} "pk" hits in the same HTML)`
        : `${user.padEnd(28)} FAILED: ${r.error}`,
    );
    await sleep(800); // keep the session at a human page-view pace
  }
} finally {
  await callJson("close_tab", { tabId: tab.tabId }).catch(() => {});
  await client.close().catch(() => {});
}

const ok = Object.fromEntries(
  results.filter((r) => r.profileId?.value).map((r) => [r.user, r.profileId.value]),
);
const failed = results.filter((r) => !r.profileId?.value).map((r) => r.user);
console.log(`\n${JSON.stringify(ok, null, 2)}`);
console.log(`\n${Object.keys(ok).length}/${results.length} succeeded${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
