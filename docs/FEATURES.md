# Feature Tour — webmcp-tools

This document lists all features. For install steps, read
[`USAGE.md`](USAGE.md). For the wire contract, read [`PROTOCOL.md`](PROTOCOL.md).

## The premise

- **Control of your real Chrome.** The project drives no disposable browser.
  It controls the Chrome that you already use, with your profile, cookies,
  and logins. It uses an MV3 extension and a native messaging bridge. The
  project does not use Playwright, Selenium, Puppeteer, or a headless
  browser. It needs no debugging port on your daily profile (Chrome 136 and
  later block that anyway).
- **Speaks MCP over stdio.** One command (`node server/dist/index.js`) works
  with Claude Desktop, Cursor, ZCode, or any MCP client.
- **WebMCP-native.** The project understands the
  [W3C WebMCP proposal](https://webmachinelearning.github.io/webmcp/)
  (`document.modelContext`). Pages can expose typed tools. Agents call these
  tools with JSON arguments instead of simulating clicks.

## The 37 tools

Each tool accepts an optional `tabId`. The default target is the active tab.
Each tool also accepts an optional `instanceId`. This parameter selects a
connected browser. Interaction tools target elements by `ref` (from
`snapshot`) or by CSS `selector`.

### Browser & tabs
| Tool | What it does |
|---|---|
| `get_browser_info` | Reports the Chrome version, user agent, and platform. Also lists every connected browser (`instances[]`). |
| `list_tabs` | Lists all tabs in all windows |
| `new_tab` | Opens a tab and activates it. The URL is optional. |
| `activate_tab` | Focuses a tab and its window |
| `close_tab` | Closes a tab |

### Navigation
| Tool | What it does |
|---|---|
| `navigate` | Opens a URL and waits for the load. The call has a timeout. |
| `go_back` / `go_forward` | Moves through the history. Reports `navigated: false` at the edges. |
| `reload` | Reloads the page. Can bypass the cache. |
| `wait_for` | Polls until text, a selector, or an element **state** (`visible`, `hidden`, `enabled`, `disabled`, `editable`) appears, or until the network goes **idle** (`networkIdle`, quiet for `idleMs`). |

### Observation
| Tool | What it does |
|---|---|
| `snapshot` | Lists the interactive elements with **stable refs**, viewport rectangles, roles, values, and select options. The result has readable lines and a JSON appendix. |
| `get_page_text` | Returns the rendered body text. Can truncate it. |
| `get_links` | Returns the first 300 anchors with text, href, and internal flag |
| `screenshot` | Captures the visible tab or the **full page**, as PNG or JPEG. Scales large images down. Returns MCP image content. |

### Interaction
| Tool | What it does |
|---|---|
| `click` | Dispatches a full pointer and mouse sequence. Supports left, right, and middle buttons, double-clicks, and modifier keys. Also clicks **viewport coordinates** (`x`/`y`) through trusted CDP input — for canvas apps and games. |
| `type_text` | Types per character with keyboard events. Sets values in a way that React accepts. Can clear first and press Enter at the end. |
| `press_key` | Presses named keys and combos (`Enter`, `Tab`, `Control+A`, `F5`, …) with correct virtual key codes |
| `hover` | Dispatches a hover-in and hover-out sequence |
| `scroll` | Scrolls the page or an element, in any direction, smooth or instant |
| `select_option` | Selects an `<option>` by value, label, or index. Fires `input` and `change`. |
| `drag` | Drags with a pointer sequence and HTML5 drag-and-drop events |

### JavaScript
| Tool | What it does |
|---|---|
| `evaluate` | Runs `"(args) => …"` in the page, in the MAIN or the ISOLATED world. Waits for promises. The tool runs over CDP. Because of this, no page or extension CSP can block it. |

### Console & network
| Tool | What it does |
|---|---|
| `get_console_logs` | Returns page console, error, and rejection entries. The MAIN-world hook collects them; a page CSP cannot block it. The hook runs on agent-driven tabs only. Ring buffer of 1000 per tab. A navigation clears it. |
| `get_network_requests` | Returns requests with timestamp, method, URL, and status from a CDP capture. Ring buffer of 500 per tab. |
| `stop_network_capture` | Detaches the network debugger |
| `get_cookies` | Reads the cookies of a tab through CDP, **including HttpOnly cookies** that `document.cookie` hides — session credentials included. Treat the values as secrets. |

### WebMCP — the differentiator
| Tool | What it does |
|---|---|
| `list_webmcp_tools` | Discovers the tools that a page exposes: native `document.modelContext` (Chrome 149+ origin trial), the polyfill, or declarative `form[toolname]` markup. Can inject the vendored polyfill on demand (`injectPolyfill: true`). |
| `call_webmcp_tool` | Executes a page-exposed tool by name with JSON arguments. The validation and handlers of the page run. No click simulation. |

### Policy, dialogs, downloads & windows
| Tool | What it does |
|---|---|
| `get_origin_policy` / `set_origin_policy` | Reads and updates the **origin policy**: an allow-list or a deny-list of host patterns (`*.example.com`) plus a list of sensitive hosts. Action tools are blocked on denied origins (`EORIGIN_POLICY`). Submits on sensitive origins require an explicit `confirm: true` (`ECONFIRM_REQUIRED`). |
| `get_dialog` | Reports the open native dialog (`alert`/`confirm`/`prompt`/`beforeunload`) on a tab and starts watching the tab for future dialogs. |
| `handle_dialog` | Answers the open dialog (`accept`, optional `promptText`) or enables **auto-dismiss** for the tab so dialogs never block automation. |
| `upload_file` | Sets a file on an `<input type=file>` by selector or ref via CDP `DOM.setFileInputFiles`. No file picker involved. |
| `list_downloads` | Lists downloads tracked by the extension (state, URL, filename, bytes, times), newest first. |
| `list_windows` / `new_window` / `resize_window` | Lists windows, opens a new one (with size), and resizes or maximizes/minimizes one. |

## Platform features

- **Two input modes.** The default mode dispatches synthetic DOM events.
  Chrome shows no debugger banner, and frameworks work. Set `trusted: true`
  to send real CDP input events instead. These events are the same as your
  own clicks and typing. Use them on pages with bot checks, on canvas apps,
  and for drags with pointer capture. A momentary debugger attach also
  powers the full-page screenshot and the network capture.
- **Several browsers at once.** Your daily Chrome and any number of test
  profiles connect at the same time. Each browser gets a stable per-profile
  `instanceId`. Each tool can select a browser. `get_browser_info` lists all
  browsers. A call without `instanceId` goes to the most recently connected
  browser.
- **Automatic reconnect.** The extension reconnects with backoff (1 s to
  30 s) when the server restarts. Start the MCP server before or after
  Chrome. The order does not matter.
- **Security model.** The hub listens on `127.0.0.1` only. A random token
  protects the handshake. The native host manifest pins `allowed_origins` to
  your deterministic extension ID. There is no telemetry and no cloud. Data
  does not leave the machine.
- **Origin policy.** An allow-list / deny-list of host patterns limits where
  the agent may act. Submits on hosts marked sensitive require an explicit
  `confirm: true`. The default policy allows everything, so nothing changes
  until you restrict it.
- **Audit log.** Every tool call is appended to
  `reports/audit/audit-YYYY-MM-DD.ndjson` (one JSON line per call: tool, tab,
  URL, outcome, duration — never the typed text or cookie values).
- **All frames and shadow DOM.** The content script runs in every frame
  (`all_frames`). `snapshot` merges elements across frames into one ref space,
  and element lookup pierces open shadow roots.
- **HTTP transport.** Run the server with `--http` to expose the same tools
  over streamable HTTP (`http://127.0.0.1:8930/mcp`) next to stdio — for
  remote agents over an ssh tunnel and for a second MCP client. See
  [`USAGE.md`](USAGE.md#http-transport).
- **Readable extension.** The extension is small, uses plain JavaScript, and
  has no dependencies and no build step. It loads no remote code. Read it
  before you load it.
- **Installers for all platforms.** Windows (HKCU, no admin; Chrome and
  Edge), macOS, and Linux.
- **Flow runner.** A flow file is plain JSON: a list of tool calls with
  variables, assertions, retries, and cleanup steps. One command runs it
  against the connected browser and writes an HTML report with embedded
  screenshots plus a JSON report. Exit code 0 means every required step
  passed. Page-side parsers live in real JavaScript files
  (`flows/lib/google-search.js`) and flow steps load them with
  `functionFile`. See [`USAGE.md`](USAGE.md#flows).
- **Tested.** The server has 138 unit tests. The E2E suite has 54 steps. It
  drives a real installed Chrome through the complete chain. The suite was
  verified while the daily Chrome of the developer stayed connected to the
  same server. CI (GitHub Actions) builds and tests every push.

## Examples

- [`examples/google-search.mjs`](../examples/google-search.mjs) — Opens
  Google in your real browser, reads the page-1 results, clicks through to
  page 2, and takes a screenshot.
- [`examples/google-search-api.mjs`](../examples/google-search-api.mjs) — A
  REST automation service (Hono). Send `POST /search
  {"query":"…","pages":2}`. The service controls your real Chrome and
  returns structured results as JSON or a rendered HTML page. Start it with
  `npm run api`.
- [`flows/google-search.json`](../flows/google-search.json) — The same search
  as a flow file: consent handling, result assertions, a screenshot, and tab
  cleanup. Start it with `npm run flow -- flows/google-search.json`.
- `demos/` — WebMCP store (imperative tools), declarative reservation form,
  and a deterministic automation playground. See
  [`USAGE.md`](USAGE.md#demos).
