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

## The 27 tools

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
| `wait_for` | Polls until a text or a CSS selector appears |

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
| `click` | Dispatches a full pointer and mouse sequence. Supports left, right, and middle buttons, double-clicks, and modifier keys. |
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

### WebMCP — the differentiator
| Tool | What it does |
|---|---|
| `list_webmcp_tools` | Discovers the tools that a page exposes: native `document.modelContext` (Chrome 149+ origin trial), the polyfill, or declarative `form[toolname]` markup. Can inject the vendored polyfill on demand (`injectPolyfill: true`). |
| `call_webmcp_tool` | Executes a page-exposed tool by name with JSON arguments. The validation and handlers of the page run. No click simulation. |

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
- **Readable extension.** The extension is small, uses plain JavaScript, and
  has no dependencies and no build step. It loads no remote code. Read it
  before you load it.
- **Installers for all platforms.** Windows (HKCU, no admin; Chrome and
  Edge), macOS, and Linux.
- **Tested.** The server has 44 unit tests. The E2E suite has 53 steps. It
  drives a real installed Chrome through the complete chain. The suite was
  verified while the daily Chrome of the developer stayed connected to the
  same server.

## Examples

- [`examples/google-search.mjs`](../examples/google-search.mjs) — Opens
  Google in your real browser, reads the page-1 results, clicks through to
  page 2, and takes a screenshot.
- [`examples/google-search-api.mjs`](../examples/google-search-api.mjs) — A
  REST automation service (Hono). Send `POST /search
  {"query":"…","pages":2}`. The service controls your real Chrome and
  returns structured results as JSON or a rendered HTML page. Start it with
  `npm run api`.
- `demos/` — WebMCP store (imperative tools), declarative reservation form,
  and a deterministic automation playground. See
  [`USAGE.md`](USAGE.md#demos).
