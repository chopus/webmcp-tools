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

## Demos

| Demo | What |
|---|---|
| `demos/webmcp-store/index.html` | Imperative WebMCP store (`search_catalog`, `add_to_cart`, `get_cart`) |
| `demos/declarative-form.html` | Declarative WebMCP (`<form toolname="reserve_table">`) |
| `demos/automation-test.html` | Deterministic playground for every classic automation tool |
| `demos/navigation-target.html` | Navigation counterpart page |
| `demos/shared/webmcp-polyfill.js` | Vendored WebMCP polyfill (Apache-2.0) |

## Layout

| Path | What |
|---|---|
| `extension/` | MV3 Chrome extension (vanilla JS, no build step) |
| `server/` | MCP server + native relay + hub (TypeScript) |
| `installer/` | Native messaging host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages + automation test pages |
| `scripts/` | Repo tooling (extension key, icons, E2E runner) |
| `test/` | E2E tests driving real Chrome through the whole stack |

Architecture and design rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status

> 🚧 Under construction — the bridge protocol is stable
> ([`docs/PROTOCOL.md`](docs/PROTOCOL.md)) and the end-to-end suite
> (`npm run e2e`) drives real Chrome through the full chain.

Roadmap ideas: element snapshot diffs / waitFor helpers on top of refs, multi-tab
session scripting, WebMCP origin-trial support as it rolls out in Chrome, and packaging
the server as a single distributable for non-developer installs.

## License

MIT. The vendored WebMCP polyfill (`demos/shared/webmcp-polyfill.js` and its copy in
`extension/lib/`) is © Google LLC under Apache-2.0, kept with its original header.
