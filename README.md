# webmcp-tools

webmcp-tools is an [MCP](https://modelcontextprotocol.io) server. It gives AI
agents full control of your real Chrome browser. The agent uses your profile,
your cookies, your logins, and your open tabs. The project does not use
Playwright, Selenium, or a headless browser.

The project has two parts:

1. **Browser automation.** A Chrome extension and a native messaging host
   control your browser. They open tabs, navigate, click, type, scroll, and
   take screenshots. They also run JavaScript, and read console logs and
   network traffic.
2. **WebMCP.** Web pages can expose structured tools through
   `document.modelContext`. The agent calls these tools with JSON arguments.
   The agent does not need to simulate clicks. See the
   [WebMCP proposal](https://webmachinelearning.github.io/webmcp/).

## Why an extension?

Chrome 136 and later ignore `--remote-debugging-port` on the default profile.
Because of this, CDP automation cannot reach your daily browser. This project
uses the supported method: an unpacked extension plus a native messaging host.
The extension uses `chrome.tabs`, `chrome.scripting`, and `chrome.debugger`.
It operates on the browser session that you use.

## Key features

- **Real session.** The agent controls the Chrome window that you already use.
  It uses your logins. It does not start a second browser.
- **WebMCP-aware.** Pages can expose typed tools, for example `search_catalog`
  or `reserve_table`. The agent calls them with JSON arguments. A vendored
  polyfill adds this function to stable Chrome.
- **27 tools.** The tools cover tabs, navigation, snapshots, clicks, typing,
  scrolling, screenshots, JavaScript evaluation, console logs, network capture,
  and WebMCP. Read the full list in [`docs/FEATURES.md`](docs/FEATURES.md).
- **Several browsers at once.** Your daily Chrome and your test profiles can
  connect at the same time. Each tool can select one browser with `instanceId`.
- **Local bridge only.** The hub listens on `127.0.0.1`. A token protects the
  connection. Data does not leave your machine.
- **Readable extension.** The extension uses plain JavaScript. It has no build
  step and no dependencies. Read the code before you load it.

## Quickstart

1. Install the dependencies and build the server:

   ```bash
   npm install && npm --prefix server install
   npm run build
   npm run install-host
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**. Select the `extension/` folder of this repository.
5. Add the server to your MCP client:

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

For the full walkthrough, read [`docs/USAGE.md`](docs/USAGE.md). It covers
Claude Desktop, Cursor, security notes, and troubleshooting.

## Tools

- **Browser & tabs** — `get_browser_info`, `list_tabs`, `new_tab`, `activate_tab`, `close_tab`
- **Navigation** — `navigate`, `go_back`, `go_forward`, `reload`, `wait_for`
- **Observation** — `snapshot`, `get_page_text`, `get_links`, `screenshot`
- **Interaction** — `click`, `type_text`, `press_key`, `hover`, `scroll`, `select_option`, `drag`
- **JavaScript** — `evaluate` (MAIN or ISOLATED world)
- **Console & network** — `get_console_logs`, `get_network_requests`, `stop_network_capture`
- **WebMCP** — `list_webmcp_tools`, `call_webmcp_tool`

For exact parameters, defaults, and result contracts, read
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Demos & examples

| Demo | What it shows |
|---|---|
| `demos/webmcp-store/index.html` | Imperative WebMCP store (`search_catalog`, `add_to_cart`, `get_cart`) |
| `demos/declarative-form.html` | Declarative WebMCP (`<form toolname="reserve_table">`) |
| `demos/automation-test.html` | Test page for every classic automation tool |
| `demos/navigation-target.html` | Pair page for navigation tests |
| `demos/shared/webmcp-polyfill.js` | Vendored WebMCP polyfill (Apache-2.0) |
| `examples/google-search.mjs` | Search in your real browser: read results, click "Next", take a screenshot |
| `examples/google-search-api.mjs` | REST service: `POST /search` controls your Chrome and returns the results |

## Layout

| Path | What it contains |
|---|---|
| `extension/` | MV3 Chrome extension (plain JavaScript, no build step) |
| `server/` | MCP server, native relay, and hub (TypeScript) |
| `installer/` | Native messaging host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages and automation test pages |
| `examples/` | Runnable example scripts |
| `docs/` | Architecture, protocol, features, and usage guides |
| `scripts/` | Repository tooling (extension key, icons, E2E runner) |
| `test/` | E2E test that drives a real Chrome through the full stack |

For the design rationale, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status

The project works end to end. The server has 44 unit tests. The E2E suite has
53 steps. It loads the unpacked extension into a real installed Chrome. It
exercises 26 of the 27 tools through the complete chain: MCP client, hub,
native relay, extension. The suite also runs while a daily Chrome stays
connected to the same server.

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
© Google LLC under Apache-2.0. The file
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt) contains the full license
text. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the details.
