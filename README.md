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
- **37 tools.** The tools cover tabs, windows, navigation, snapshots, clicks,
  typing, scrolling, screenshots, JavaScript evaluation, console logs, network
  capture, file upload, downloads, native dialogs, an origin policy, and
  WebMCP. Read the full list in [`docs/FEATURES.md`](docs/FEATURES.md).
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
- **Console & network** — `get_console_logs`, `get_network_requests`, `stop_network_capture`, `get_cookies`
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
| `flows/google-search.json` | Flow file: the same Google search with retries, assertions, and an HTML report. Run `npm run flow -- flows/google-search.json --var query=capybara` |

## Layout

| Path | What it contains |
|---|---|
| `extension/` | MV3 Chrome extension (plain JavaScript, no build step) |
| `server/` | MCP server, native relay, hub, and flow runner (TypeScript) |
| `installer/` | Native messaging host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages and automation test pages |
| `examples/` | Runnable example scripts |
| `flows/` | Flow files you run with `npm run flow -- <file.json>` |
| `docs/` | Architecture, protocol, features, and usage guides |
| `scripts/` | Repository tooling (extension key, icons, E2E runner) |
| `test/` | E2E test that drives a real Chrome through the full stack |

For the design rationale, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status

The project works end to end. The server has 138 unit tests. The E2E suite has
54 steps. It loads the unpacked extension into a real installed Chrome. It
exercises the tools through the complete chain: MCP client, hub, native relay,
extension. The suite also runs while a daily Chrome stays connected to the same
server. The flow runner and its Google search parser were tested against the
same daily Chrome.

## Roadmap — known gaps and future updates

### Shipped 2026-09-16

- [x] **Origin policy** — `get_origin_policy` / `set_origin_policy` with
  allow-lists, deny-lists, and sensitive hosts. Submits on sensitive domains
  require `confirm: true`.
- [x] **Audit log** — every tool call is appended to
  `reports/audit/audit-YYYY-MM-DD.ndjson` (tool, tab, URL, outcome, duration).
- [x] **Native dialogs** — `get_dialog` / `handle_dialog` answer open dialogs
  and can auto-dismiss them per tab, so a dialog never blocks automation.
- [x] **Element-state waits** — `wait_for` accepts element states (`visible`,
  `hidden`, `enabled`, `disabled`, `editable`) and `networkIdle`.
- [x] **iframes and shadow DOM** — the content script runs in all frames;
  `snapshot` merges frames into one ref space and lookup pierces shadow roots.
- [x] **Coordinate clicks** — `click` accepts viewport `x`/`y` through trusted
  CDP input.
- [x] **File upload and downloads** — `upload_file` sets files via CDP, and
  `list_downloads` tracks downloads.
- [x] **Window management** — `list_windows`, `new_window`, `resize_window`.
- [x] **REST queue persistence** — the REST example persists its job queue to
  disk (`data/jobs.jsonl` + `data/pending.json`) and replays pending jobs on
  restart.
- [x] **HTTP transport** — `--http` exposes the same tools over streamable
  HTTP next to stdio, so a remote agent or a second MCP client can connect.

### Gaps in daily automation

- [ ] **History and bookmarks** — cookies are covered (`get_cookies`), but no
  tool exposes browsing history or bookmarks yet.
- [ ] **PDF, touch, clipboard** — The tools do not export PDF files. They do
  not emulate touch input. They do not read the clipboard.

### Product-level gaps

- [ ] **Recorder** — There is no record mode. You cannot record your manual
  actions and get a replayable script.
- [ ] **Disposable browsers** — The tools control connected browsers only. They cannot start a fresh isolated profile for each job. Only the E2E harness does this, through CDP.
- [ ] **Distribution** — CI runs build and tests (`.github/workflows/ci.yml`)
  and a changelog exists, but the package is not on npm. There are no releases
  or tags.
- [ ] **WebMCP origin trial** — Track the native WebMCP rollout in Chrome. The tests exercise the polyfill path today. Related ideas: snapshot diffs and multi-tab session scripts on top of refs.

## License

MIT — see [LICENSE](LICENSE). The vendored WebMCP polyfill
(`demos/shared/webmcp-polyfill.js` and `extension/lib/webmcp-polyfill.js`) is
© Google LLC under Apache-2.0. The file
[LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt) contains the full license
text. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the details.
