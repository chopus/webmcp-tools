---
name: webmcp-browser
description: Drive the user's real Chrome browser — their profile, cookies, logins, and open tabs — through the webmcp-tools MCP server in this repository. Use whenever a task means opening, navigating, clicking, typing, filling forms, screenshotting, scraping rendered pages, reading console or network traffic, testing a web app in a signed-in browser, testing this project's own tool stack end to end, or calling page-exposed WebMCP tools — even if the user just says "check this page" or "open the site and grab…". This replaces Playwright/Selenium/headless-browser approaches when it is available.
---

# webmcp-browser — drive the real Chrome

webmcp-tools controls the Chrome the user actually uses (extension + native
messaging host — no Playwright, no headless browser, no debugging port on the
daily profile). When this skill applies, do not spin up any other browser
automation. Everything stays on the machine: the hub binds to `127.0.0.1` and
every tool call is appended to `reports/audit/audit-YYYY-MM-DD.ndjson`.

Run commands from the repository root — your webmcp-tools checkout (e.g. `C:\dev\webmcp-tools` on Windows, `/Users/dalinfo-pro-03/dev/webmcp-tools` on macOS).

## Pick an access path

1. **MCP tools in the session.** If the tool list contains `mcp__webmcp-browser__*`
   tools (e.g. `mcp__webmcp-browser__snapshot`), call them directly — the tool
   contracts below are identical. Do **not** also start a server process: two
   server processes fight over one hub discovery file and break each other.
2. **HTTP helper (default when no MCP tools are registered).**
   `node .agents/skills/webmcp-browser/scripts/webmcp-call.mjs <tool> '<json-args>'`
   The helper starts `server/dist/index.js --http` on `127.0.0.1:8930` if
   nothing is listening, reuses the session across invocations, retries while
   the extension reconnects (~30 s after a fresh server start), and prints the
   tool's text result. Screenshots are saved to a file and the path is printed.
   Stop a server the helper started with `… webmcp-call.mjs stop`.
   For `evaluate`, shell-quoted JSON mangles backslashes/quotes in real
   functions — pass them as files instead: `--function-file probe.js` (the
   function source), `--args-file vars.json` (JSON args object, merged under
   inline args), or a positional `-` to read the JSON args from stdin.
3. **Flow runner for scripted sequences.** Deterministic, repeated, or
   assertion-heavy automation → write a flow JSON (steps = tool calls, with
   `expect` assertions, `retries`, `save`/`{{var}}` templating, `finally`
   cleanup) and run:
   `npm run flow -- flows/<file>.json --var query=…`
   Exit code 0 means every required step passed; an HTML + JSON report lands
   in `reports/`. A running flow takes over the hub — do not drive the browser
   through another path at the same time.

## First call — always

Call `get_browser_info` first (helper: `webmcp-call.mjs status`). It proves
the whole chain and lists every connected browser in `instances[]`; grab the
`instanceId` when several are connected. `extension_not_connected` means the
extension is not loaded, the native host is missing, or it is still
reconnecting — wait up to ~30 s, then see `docs/USAGE.md#troubleshooting`.

## Core loop

`new_tab`/`navigate` → `wait_for` → `snapshot` → act by `ref` → verify.

- Target elements with `ref` (an int from `snapshot`) **or** a CSS `selector` —
  exactly one per call. Refs are stable only until the tab navigates.
- `snapshot` merges all frames and open shadow roots into one ref space.
  After acting, re-snapshot if the DOM may have changed.
- Omit `tabId` to target the active tab. Pass `instanceId` to pick a browser.
- Verify with `get_page_text`, `screenshot`, `get_console_logs`,
  `get_network_requests` (the network capture starts with the first call).

Example (helper path):

```bash
W=.agents/skills/webmcp-browser/scripts/webmcp-call.mjs
node $W status
node $W new_tab '{"url":"https://example.com"}'
node $W wait_for '{"selector":"h1"}'
node $W snapshot
node $W click '{"selector":"a.more"}'
node $W screenshot '{"fullPage":true}'
node $W close_tab '{"tabId":<id from new_tab>}'
```

`wait_for` polls ~250 ms for `text`, `selector` (optionally with `state`:
`visible|hidden|enabled|disabled|editable`), or `networkIdle` (+`idleMs`).

## Input modes

Default is DOM mode: synthetic events, no debugger banner, React-friendly.
Add `"trusted": true` when a page ignores synthetic input — bot detection,
canvas apps, pointer-capture drags. Trusted mode attaches the debugger
briefly, so Chrome shows the "webmcp-tools started debugging this browser"
infobar; that is expected. `click` also accepts viewport `x`/`y` (trusted CDP
input) for canvas apps and games.

## WebMCP — try it before clicking

Pages can expose typed tools through `document.modelContext` (imperative) or
`<form toolname="…">` (declarative). On stable Chrome pass
`injectPolyfill: true` to the discovery call:

- `list_webmcp_tools` → tool names + JSON schemas
- `call_webmcp_tool` `{"name":"search_catalog","args":{…}}` — JSON in, JSON
  out; the page's own validation and handlers run. No click simulation.

Prefer these over UI simulation whenever the page offers them.

## Safety — this is the user's real browser

- Tools act with the user's logins. Never purchase, send messages/posts/emails,
  delete or mutate account data, or accept unexpected dialogs unless the user
  explicitly asked for that exact action.
- The origin policy can mark hosts sensitive; submits there fail with
  `ECONFIRM_REQUIRED` until you pass `confirm: true` — ask the user first.
- `get_cookies` returns session credentials including HttpOnly values. Treat
  them as secrets: never echo them into reports, logs, or messages.
- Clean up: close tabs you opened (`close_tab`) when done.
- Debugger-backed tools (`evaluate`, network capture, full-page screenshots,
  trusted input) cannot run on a tab that has DevTools open. That conflict
  (and a stalled debugger attach) fails fast with `EDEBUGGER` naming DevTools
  — close DevTools on the target tab and retry.
- Chrome's Memory Saver freezes background tabs; a frozen renderer runs no
  scripts, so debugger-backed tools targeting one fail fast with
  `ETAB_FROZEN`. Activate the tab first (`activate_tab`), or pass
  `unfreeze: true` to `evaluate` (it activates the tab — focus moves — then
  waits for the thaw/reload).

## Exact parameters

Full parameter tables, result shapes, and error codes live in
`references/tool-catalog.md` inside this skill. Within this repository,
`docs/USAGE.md` and `docs/PROTOCOL.md` are canonical and may be newer — when
in doubt, read those.
