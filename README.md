# webmcp-tools

A fully featured [MCP](https://modelcontextprotocol.io) server that lets AI agents drive
**your real Chrome browser** — your actual profile, cookies, logins and tabs. No
Playwright, no Selenium, no headless browser.

It combines two ideas:

1. **Full browser automation** through a Chrome extension + native messaging bridge:
   tabs, navigation, snapshots, clicks, typing, scrolling, screenshots, JS evaluation,
   console logs and network capture — executed in your real session.
2. **[WebMCP](https://webmachinelearning.github.io/webmcp/)**: agents can discover and
   call structured tools that web pages expose via `document.modelContext` (imperative)
   and declarative `form[toolname]` — the page-actuation API that replaces brittle
   simulated clicks when available.

Since Chrome 136, `--remote-debugging-port` is ignored on the default profile, so CDP
automation can no longer reach your daily browser. The supported path — and the one this
project takes — is an unpacked extension plus a native messaging host: full
`chrome.tabs` / `chrome.scripting` / `chrome.debugger` power, attached to the session
you actually use.

## Highlights

- **Real session, real logins.** Drives the Chrome you already have open, not a
  disposable headless instance — no Playwright, no Selenium, no browser download.
- **WebMCP-aware.** Beyond classic automation, pages can expose typed tools
  (`search_catalog`, `reserve_table`, …) that agents call with JSON args; a vendored
  polyfill makes this work on stable Chrome today.
- **27 tools across the stack.** Tabs, navigation, accessibility-style snapshots,
  interaction (DOM-synthetic or trusted CDP input), JS evaluation in both worlds,
  console logs, network capture, screenshots, and WebMCP list/call.
  Full tour: [`docs/FEATURES.md`](docs/FEATURES.md).
- **Multiple browsers at once.** Daily Chrome + test profiles connect side by side;
  every tool can target a specific browser by `instanceId`.
- **Localhost-only, token-gated bridge.** The hub binds `127.0.0.1`, the native host is
  pinned to your deterministic extension ID, and nothing leaves the machine.
- **No build step on the extension side** — a small, readable, dependency-free MV3
  extension you can audit before loading.

## Quickstart

```bash
npm install && npm --prefix server install
npm run build
npm run install-host          # registers the native messaging host
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` folder. Finally point your MCP client at the server:

```json
{
  "mcpServers": {
    "webmcp-browser": {
      "command": "node",
      "args": ["<absolute path>/webmcp-tools/server/dist/index.js"]
    }
  }
}
```

Full walkthrough (Claude Desktop / Cursor, troubleshooting, security notes):
[`docs/USAGE.md`](docs/USAGE.md).

## Tools

- **Browser & tabs** — `get_browser_info`, `list_tabs`, `new_tab`, `activate_tab`, `close_tab`
- **Navigation** — `navigate`, `go_back`, `go_forward`, `reload`, `wait_for`
- **Observation** — `snapshot`, `get_page_text`, `get_links`, `screenshot`
- **Interaction** — `click`, `type_text`, `press_key`, `hover`, `scroll`, `select_option`, `drag`
- **JavaScript** — `evaluate` (MAIN or ISOLATED world)
- **Console & network** — `get_console_logs`, `get_network_requests`, `stop_network_capture`
- **WebMCP** — `list_webmcp_tools`, `call_webmcp_tool`

Exact parameter shapes, defaults and result contracts: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Demos & examples

| Demo | What |
|---|---|
| `demos/webmcp-store/index.html` | Imperative WebMCP store (`search_catalog`, `add_to_cart`, `get_cart`) |
| `demos/declarative-form.html` | Declarative WebMCP (`<form toolname="reserve_table">`) |
| `demos/automation-test.html` | Deterministic playground for every classic automation tool |
| `demos/navigation-target.html` | Navigation counterpart page |
| `demos/shared/webmcp-polyfill.js` | Vendored WebMCP polyfill (Apache-2.0) |
| `examples/google-search.mjs` | Live search in your real browser: read results, click "Next", screenshot |

## Layout

| Path | What |
|---|---|
| `extension/` | MV3 Chrome extension (vanilla JS, no build step) |
| `server/` | MCP server + native relay + hub (TypeScript) |
| `installer/` | Native messaging host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages + automation test pages |
| `examples/` | Runnable example scripts |
| `docs/` | Architecture, protocol, features, usage guides |
| `scripts/` | Repo tooling (extension key, icons, E2E runner) |
| `test/` | E2E tests driving real Chrome through the whole stack |

Architecture and design rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status

Working end to end: 44 server unit tests, and a 53-step E2E suite
(`npm run e2e`) that loads the unpacked extension into a real installed Chrome
and exercises 26 of 27 tools through the full MCP → hub → native-relay →
extension chain — verified running while a daily Chrome stays connected to the
same server.

## Roadmap — known gaps & future updates

### Gaps you'd hit in daily automation use

- [ ] **iframes & shadow DOM** — the content script is main-frame only; snapshot/click can't reach into cross-origin iframes or pierce shadow roots (banks, embedded players, many SPAs)
- [ ] **File upload & downloads** — no `upload_file` tool, no download tracking
- [ ] **Native dialogs** — `alert`/`confirm`/`prompt` and `beforeunload` aren't auto-handled; a stuck dialog blocks everything
- [ ] **Window management** — no create/resize/position/maximize window tools
- [ ] **Coordinate clicking** — no "click at x,y" (needed for canvas/games when refs don't exist)
- [ ] **Element-state waits** — `wait_for` covers text/selector only; no wait-for-enabled/visible/editable, no network-idle wait
- [ ] **Cookies/storage view** — the extension could expose `chrome.cookies`, history, bookmarks; none of that is surfaced
- [ ] **PDF export, touch emulation, clipboard** — not exposed

### Missing to be a product rather than a dev tool

- [ ] **Recorder / codegen** — you can't click around and get a replayable script out
- [ ] **Flow runner** — no `webmcp run flow.json` with retries/assertions/HTML reports (the REST API example queues in memory only; no persistence)
- [ ] **Disposable-browser tooling** — the product drives connected browsers but can't launch a fresh isolated profile per job itself (only the E2E harness does, via CDP)
- [ ] **stdio-only MCP** — no HTTP/SSE transport, so remote agents can't connect across machines; also only one MCP client at a time (the hub-file race documented in USAGE)
- [ ] **Distribution** — not on npm (`npx webmcp-browser` should be a thing), no packaged installer for non-developers, no CI (`.github/workflows` is empty — no test automation on push), no tags/releases/CHANGELOG
- [ ] **WebMCP origin-trial support** — track Chrome's native WebMCP rollout (currently the polyfill path is what tests exercise); element snapshot diffs and multi-tab session scripting on top of refs

### Security hardening worth adding

- [ ] **Origin policy layer** — the agent can act on *every* site you're logged into, including your bank; an allow/deny-list (and confirmation gates for submits on sensitive domains) would be the responsible next step
- [ ] **Audit log** — nothing records what the agent did for later review

## License

MIT — see [LICENSE](LICENSE). The vendored WebMCP polyfill
(`demos/shared/webmcp-polyfill.js` and `extension/lib/webmcp-polyfill.js`) is
© Google LLC under Apache-2.0; its full text ships as
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt), with details in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
