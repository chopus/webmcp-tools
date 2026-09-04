# Feature Tour — webmcp-tools

What you get, end to end. For install steps see [`USAGE.md`](USAGE.md); for the
wire contract see [`PROTOCOL.md`](PROTOCOL.md).

## The premise

- **Drives your real Chrome** — your actual profile, cookies, and logins — through an
  MV3 extension + native messaging bridge. No Playwright, no Selenium, no Puppeteer,
  no headless browser, and no debugging port on your daily profile (Chrome 136+ blocks
  that anyway).
- **Speaks MCP over stdio** — one command (`node server/dist/index.js`) works with
  Claude Desktop, Cursor, ZCode, or any MCP client.
- **WebMCP-native** — understands the [W3C WebMCP proposal](https://webmachinelearning.github.io/webmcp/)
  (`document.modelContext`), so agents call structured page-exposed tools with JSON
  args instead of simulating clicks, whenever a page offers them.

## The 27 tools

Every tool accepts an optional `tabId` (defaults to the active tab) and an optional
`instanceId` (target a specific connected browser). Interaction tools target elements
by `ref` (from `snapshot`) or CSS `selector`.

### Browser & tabs
| Tool | What it does |
|---|---|
| `get_browser_info` | Chrome version, UA, platform — plus every connected browser instance (`instances[]`) |
| `list_tabs` | All tabs across all windows |
| `new_tab` | Open (and activate) a tab, optionally with a URL |
| `activate_tab` | Focus a tab and its window |
| `close_tab` | Close a tab |

### Navigation
| Tool | What it does |
|---|---|
| `navigate` | Go to a URL and wait for load (timeout-protected) |
| `go_back` / `go_forward` | History navigation; reports `navigated: false` at the edges |
| `reload` | Reload, optionally bypassing the cache |
| `wait_for` | Poll until a text or CSS selector appears |

### Observation
| Tool | What it does |
|---|---|
| `snapshot` | Accessibility-style listing of interactive elements with **stable refs**, viewport rects, roles, values, select options — human-readable lines + JSON appendix |
| `get_page_text` | Rendered body text (truncatable) |
| `get_links` | Anchors with text/href/internal flag (first 300) |
| `screenshot` | Visible-tab or **full-page** PNG/JPEG, auto-downscaled, returned as MCP image content |

### Interaction
| Tool | What it does |
|---|---|
| `click` | Full pointer/mouse sequence; left/right/middle button, double-click, modifier keys |
| `type_text` | Per-char keyboard events with React-compatible value setting; optional clear-first and Enter-to-submit |
| `press_key` | Named keys and combos (`Enter`, `Tab`, `Control+A`, `F5`…) with proper virtual key codes |
| `hover` | Hover-in/out sequence |
| `scroll` | Page or element scroll, any direction, smooth or instant |
| `select_option` | Pick an `<option>` by value/label/index; fires `input` + `change` |
| `drag` | Pointer-sequence drag including HTML5 drag-and-drop events |

### JavaScript
| Tool | What it does |
|---|---|
| `evaluate` | Run `"(args) => …"` in the page, MAIN or ISOLATED world, promise-aware. Executed over CDP, so **page and extension CSP cannot block it** |

### Console & network
| Tool | What it does |
|---|---|
| `get_console_logs` | Page console/error/unhandled-rejection entries (MAIN-world hook, CSP-exempt), 1000/tab ring buffer cleared on navigation |
| `get_network_requests` | Requests with timestamp/method/URL/status via CDP capture (500/tab ring buffer) |
| `stop_network_capture` | Detach the network debugger |

### WebMCP — the differentiator
| Tool | What it does |
|---|---|
| `list_webmcp_tools` | Discover tools the page exposes — native `document.modelContext` (Chrome 149+ origin trial), the polyfill, or declarative `form[toolname]` markup. Can inject the vendored polyfill on demand (`injectPolyfill: true`) |
| `call_webmcp_tool` | Execute a page-exposed tool by name with JSON args — structured page actuation: the page's own validation and handlers run, no click simulation |

## Platform features

- **Two input modes.** Default is synthetic DOM events (no debugger banner, framework
  friendly). `trusted: true` switches to real CDP input events — indistinguishable
  from your own clicks/typing — for bot-checked pages, canvas apps, and pointer-capture
  drags. The same momentary debugger attach powers full-page screenshots and network
  capture.
- **Multiple browsers at once.** Connect your daily Chrome and any number of test
  profiles simultaneously; each gets a stable per-profile `instanceId`, every tool can
  target a specific browser, and `get_browser_info` lists them all. Calls without an
  `instanceId` go to the most recently connected browser.
- **Self-healing link.** The extension reconnects with backoff (1 s → 30 s) whenever
  the server restarts — start the MCP server before or after Chrome, in any order.
- **Security model.** Hub binds `127.0.0.1` only with a random token handshake; the
  native host manifest pins `allowed_origins` to your deterministic extension ID;
  no telemetry, no cloud, nothing leaves the machine.
- **Auditable extension.** Small, dependency-free vanilla JS — no build step, no
  remote code. Read it before you load it.
- **Cross-platform installers.** Windows (HKCU, no admin; Chrome and Edge), macOS,
  and Linux.
- **Proven.** 44 server unit tests and a 53-step E2E suite that drives a real
  installed Chrome through the entire chain — verified running *while* the developer's
  daily Chrome stayed connected to the same server.

## Examples

- [`examples/google-search.mjs`](../examples/google-search.mjs) — open Google in your
  real browser, read page-1 results, click through to page 2, screenshot it.
- [`examples/google-search-api.mjs`](../examples/google-search-api.mjs) — a REST
  automation **service** (Hono): `POST /search {"query":"…","pages":2}` drives your
  real Chrome and returns structured results as JSON or a rendered HTML page;
  run it with `npm run api`.
- `demos/` — WebMCP store (imperative tools), declarative reservation form, and a
  deterministic automation playground; see [`USAGE.md`](USAGE.md#demos).
