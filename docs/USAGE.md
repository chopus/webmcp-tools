# Usage Guide — webmcp-tools

`webmcp-tools` is an [MCP](https://modelcontextprotocol.io) server that gives AI
agents full control of **your real Chrome browser** — the profile, cookies,
logins and tabs you already have — through a tiny extension + native messaging
bridge. On top of classic automation (tabs, navigation, clicking, typing,
screenshots, JS evaluation, console and network capture) it is
**[WebMCP](https://webmachinelearning.github.io/webmcp/)-aware**: it can
discover and call structured tools that web pages themselves expose via
`document.modelContext`, both imperative and declarative. For how the pieces
fit together, read [`ARCHITECTURE.md`](ARCHITECTURE.md); the wire contract is
in [`PROTOCOL.md`](PROTOCOL.md).

---

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuring an MCP client](#configuring-an-mcp-client)
- [Tool catalog (27 tools)](#tool-catalog-27-tools)
- [The two input modes (DOM vs trusted)](#the-two-input-modes-dom-vs-trusted)
- [WebMCP: page-exposed tools](#webmcp-page-exposed-tools)
- [Demos](#demos)
- [Security & privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20+** | Node 22+ recommended (the E2E harness uses the global `WebSocket`). Node 24 tested. |
| **Chrome 116+** | Modern MV3 service-worker behavior required. Chrome 152 tested. |
| **OS** | Windows, macOS or Linux. Installers provided for all three. |

## Installation

From the repository root:

```bash
npm install                 # root dev dependencies (MCP client SDK, tooling)
npm --prefix server install # server dependencies
npm run build               # compiles server/ TypeScript → server/dist/
npm run install-host        # registers the native messaging host (HKCU / ~/.config)
```

`npm run install-host` is an alias of `installer/install-host.ps1` on Windows;
on macOS/Linux run `sh installer/install-host.sh` instead. The installer:

1. generates `extension/key.pem` if missing (via `scripts/ensure-key.mjs`) so
   your extension ID is **deterministic**,
2. writes the native-messaging host manifest that points at
   `server/bin/webmcp-host.cmd|sh`, which re-launches `server/dist/index.js`
   with `--native-host`,
3. pins `allowed_origins` to `chrome-extension://<your-id>/` — no other
   extension can talk to your host.

Then load the extension **once** into your normal Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder of this repo.

> **Heads-up: this is your REAL browser.** The extension runs in your daily
> Chrome with your real profile and logins — that is the entire point, but it
> also means the agent can act on any site you are signed into. The bridge
> only ever talks to `127.0.0.1` through the native host; nothing leaves your
> machine. Review the (small, vanilla-JS) extension source before loading it.

Finally, add the server to your MCP client (below). Whenever the MCP client
starts the server, the extension's service worker connects to it through the
native host automatically.

## Configuring an MCP client

### Claude Desktop

Edit `claude_desktop_config.json` (Windows:
`%APPDATA%\Claude\claude_desktop_config.json`; macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webmcp-browser": {
      "command": "node",
      "args": ["C:/dev/webmcp-tools/server/dist/index.js"]
    }
  }
}
```

Use the **absolute** path on your machine, with forward slashes (works on
Windows too). Restart Claude Desktop after saving.

### Cursor

Create `.cursor/mcp.json` in the project (or the global config) with the same
shape:

```json
{
  "mcpServers": {
    "webmcp-browser": {
      "command": "node",
      "args": ["/home/you/dev/webmcp-tools/server/dist/index.js"]
    }
  }
}
```

### Any stdio MCP client

| Field | Value |
|---|---|
| Transport | `stdio` |
| Command | `node` |
| Args | `["<absolute path>/server/dist/index.js"]` |
| Env | none required |

There is no HTTP/WebSocket endpoint to configure: the MCP client spawns the
server over stdio, and the server's hub binds an ephemeral port on
`127.0.0.1` that only the native relay (with the token from
`os.tmpdir()/webmcp-tools-hub.json`) may use.

## Tool catalog (27 tools)

All params are optional unless marked **required**. Any tool that accepts
`tabId` targets the **active tab of the last-focused window** when omitted.
Interaction tools take **exactly one** of `ref` (from `snapshot`) or
`selector` (CSS).

### Browser & tabs

| Tool | Params | Result |
|---|---|---|
| `get_browser_info` | — | `{ chromeVersion, userAgent, platform, extensionVersion }` |
| `list_tabs` | — | `{ tabs: Tab[] }` across all windows |
| `new_tab` | `url` (default `about:blank`), `active` (default `true`), `windowId` | `{ tab: Tab }` |
| `activate_tab` | `tabId` **required** | `{ tab: Tab }` (also focuses its window) |
| `close_tab` | `tabId` **required** | `{ closed: true }` |

### Navigation

| Tool | Params | Result |
|---|---|---|
| `navigate` | `url` **required**, `tabId`, `timeoutMs` (default `30000`) | `{ tabId, url, title }` — resolves on `status === "complete"` |
| `go_back` | `tabId`, `timeoutMs` (default `15000`) | `{ tabId, url, title }` (`navigated: false` if no history) |
| `go_forward` | `tabId`, `timeoutMs` (default `15000`) | `{ tabId, url, title }` (`navigated: false` if no history) |
| `reload` | `tabId`, `bypassCache` (default `false`), `timeoutMs` (default `30000`) | `{ tabId, url, title }` |
| `wait_for` | exactly one of `text` or `selector` **required**, `tabId`, `timeoutMs` (default `10000`) | `{ found, matched: "text"\|"selector"\|"none", tabId, url, title }` — polls ~250 ms |

### Observation

| Tool | Params | Result |
|---|---|---|
| `snapshot` | `tabId`, `maxElements` (default `800`), `viewportOnly` (default `false`) | Accessibility-style listing: `[ref] tag "text" (role, value…)` per line + JSON appendix with `viewport`, `elements[]` (each with `ref`, `tag`, `role`, `text`, `rect`, `visible`, …) and `truncated` |
| `get_page_text` | `tabId`, `maxChars` (default `20000`) | `{ tabId, url, title, text, truncated }` — `innerText` of `<body>` |
| `get_links` | `tabId` | `{ links: [{ text, href, internal }] }` — first 300 anchors |
| `screenshot` | `tabId`, `format` (`"png"` default \| `"jpeg"`), `quality` (default `80`), `fullPage` (default `false`), `maxWidth` (default `1600`) | MCP **image** content (base64), `{ format, width, height }` |

### Interaction

| Tool | Params | Result |
|---|---|---|
| `click` | `ref`/`selector` **required**, `tabId`, `button` (`"left"` default), `clickCount` (default `1`; `2` = double-click), `modifiers` (default `[]`), `trusted` (default `false`), `timeoutMs` (default `5000`) | `{ clicked: true, tag, text? }` |
| `type_text` | `ref`/`selector`, `text` **required**, `tabId`, `clearFirst` (default `true`), `submit` (default `false`, presses Enter after typing), `trusted` (default `false`), `timeoutMs` (default `10000`) | `{ typed: true }` |
| `press_key` | `key` **required** (`Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+A`, …), `ref`/`selector`, `tabId`, `trusted` (default `false`), `timeoutMs` (default `5000`) | `{ pressed: true }` |
| `hover` | `ref`/`selector` **required**, `tabId`, `timeoutMs` (default `5000`) | `{ hovered: true }` |
| `scroll` | `tabId`, `direction` (`"up"`/`"down"`/`"left"`/`"right"`, default `"down"`), `amount` (default `600`), `ref`/`selector` (scrolls that element), `smooth` (default `true`) | `{ scrollX, scrollY }` |
| `select_option` | `ref`/`selector` **required**, exactly one of `value`/`label`/`index`, `tabId`, `timeoutMs` (default `5000`) | `{ selected: string[] }` — fires `input` + `change` |
| `drag` | `fromRef`/`fromSelector` and `toRef`/`toSelector` **required**, `tabId`, `trusted` (default `false`), `timeoutMs` (default `8000`) | `{ dragged: true }` |

### JavaScript

| Tool | Params | Result |
|---|---|---|
| `evaluate` | `function` **required** (`"(args) => …"` — expression or promise), `args` (default `{}`), `tabId`, `world` (`"MAIN"` default \| `"ISOLATED"`), `awaitPromise` (default `true`), `timeoutMs` (default `10000`) | `{ result }` — JSON-serializable values only; non-serializable → `{ result: null, exception: "non-serializable result" }` |

### Console & network

| Tool | Params | Result |
|---|---|---|
| `get_console_logs` | `tabId`, `levels` (default all), `lastN` (default `200`) | `{ logs: [{ ts, tabId, level, text }] }` — ring buffer 1000/tab, cleared on navigation |
| `get_network_requests` | `tabId`, `urlContains`, `lastN` (default `50`) | `{ requests: [{ ts, method, url, status, type }] }` — attaches `chrome.debugger` + `Network.enable`; ring buffer 500/tab. First call starts capture (earlier requests are not buffered). |
| `stop_network_capture` | `tabId` | `{ stopped: true }` — detaches the debugger if attached only for capture |

### WebMCP

| Tool | Params | Result |
|---|---|---|
| `list_webmcp_tools` | `tabId`, `injectPolyfill` (default `false`) | `{ supported, mode: "native"\|"polyfill"\|"declarative"\|"none", tools: [{ name, title?, description?, inputSchema?, origin?, annotations? }] }` |
| `call_webmcp_tool` | `name` **required**, `args` (default `{}`), `tabId`, `timeoutMs` (default `30000`) | `{ ok: true, result }` — the tool's JSON result; failures surface as `EWEBMCP` errors |

## The two input modes (DOM vs trusted)

Every interaction tool works in one of two modes:

- **DOM mode (default, `trusted: false`).** A content script scrolls the
  element into view and dispatches synthetic pointer/keyboard event sequences
  that respect React/Vue expectations. No debugger banner; covers the vast
  majority of pages.
- **Trusted mode (`trusted: true`).** The extension attaches `chrome.debugger`
  to the tab and sends CDP `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent` / `Input.insertText` using the element's on-screen
  coordinates. These are *real* input events — indistinguishable from your
  own — which matters for pages that ignore synthetic events (bot detection,
  canvas games, drag-and-drop with pointer capture). While attached, Chrome
  shows its standard infobar: **"webmcp-tools started debugging this
  browser"**. The extension detaches as soon as the action completes.

The same debugger attach is also used internally for `fullPage` screenshots
and network capture — you may see the infobar flash for those too. That is
expected and safe.

## WebMCP: page-exposed tools

WebMCP lets a **page** declare agent-facing tools, so the agent calls
structured APIs instead of simulating clicks:

- **Imperative:** the page calls
  `document.modelContext.registerTool({ name, description, inputSchema, execute })`.
- **Declarative:** the page just writes
  `<form toolname="reserve_table" tooldescription="…">` and the schema is
  derived from the form fields (`toolparamdescription` attributes become
  parameter descriptions).

`list_webmcp_tools` inspects a tab (in the page's MAIN world) and reports
what it finds. `call_webmcp_tool` executes one by name with JSON args — for
declarative forms the extension fills the fields and submits the form, so the
page's own validation and handlers run.

- **Native WebMCP** ships behind an origin trial starting with Chrome 149; you
  can enable it for testing at `chrome://flags/#enable-webmcp-testing`.
- On **stable Chrome** (or any page that did not bring its own polyfill), pass
  `injectPolyfill: true` to `list_webmcp_tools` and the extension injects the
  vendored WebMCP polyfill (`demos/shared/webmcp-polyfill.js`, also vendored
  inside the extension) into the page before discovery. Pages that already
  load a polyfill are discovered without any injection.

Try it with the demos below — serve them statically (`npx serve demos` or
`python -m http.server` from `demos/`) and ask your agent: *"list the WebMCP
tools on http://localhost:3000/webmcp-store/index.html and add two espressos
to the cart."*

## Demos

| Demo | What it shows |
|---|---|
| `demos/webmcp-store/index.html` | Imperative WebMCP: a coffee & pizza shop registering `search_catalog`, `add_to_cart`, `get_cart`; the human UI and the agent tools share one implementation |
| `demos/declarative-form.html` | Declarative WebMCP: a restaurant reservation expressed entirely as `<form toolname="reserve_table">` markup |
| `demos/automation-test.html` | Deterministic playground for every classic automation tool (click/dblclick/type/select/hover/scroll/keys/console/links) |
| `demos/navigation-target.html` | Pair page for navigate / go_back / go_forward / reload tests |
| `demos/shared/webmcp-polyfill.js` | Vendored WebMCP polyfill (Apache-2.0, © Google LLC) |

## Security & privacy

- **Localhost only.** The hub binds `127.0.0.1` on an ephemeral port and
  authenticates the relay with a random token stored in
  `os.tmpdir()/webmcp-tools-hub.json` (owner-only permissions, deleted on
  clean shutdown). Random local processes cannot impersonate the bridge.
- **Pinned origin.** The native host manifest's `allowed_origins` contains
  exactly your deterministic extension ID; other extensions cannot connect.
- **No telemetry, no cloud.** Nothing leaves your machine; there is no
  analytics or remote endpoint anywhere in the bridge.
- **But the extension is full browser control.** Tabs, scripting, debugger —
  the same powers a password manager has. Read `extension/` before loading
  it; it is small, dependency-free and readable in one sitting.
- **`extension/key.pem` never leaves your machine.** It is gitignored and
  generated locally by `scripts/ensure-key.mjs`. It only pins your extension
  ID — it is not a credential for anything remote, but do not commit it.
- **Uninstalling:** remove the extension in `chrome://extensions`, then run
  `npm run uninstall-host` (Windows) or `sh installer/uninstall-host.sh` to
  delete the native host registration. Kill any running MCP server process;
  the hub socket and token file die with it.

## Troubleshooting

**`extension_not_connected` from every tool call.**
The extension is not loaded, or the native host is not installed, or the
server was (re)started after Chrome and the service worker has not
reconnected yet (it retries with backoff up to 30 s — wait a moment or toggle
the extension off/on in `chrome://extensions`). Verify the host with
`npm run install-host`; check `chrome://extensions` → the extension →
"service worker" console for native-host errors.

**Extension ID mismatch after regenerating `key.pem`.**
Deleting `extension/key.pem` changes your extension ID, so the installed
native host manifest (pinned to the old ID) no longer matches. Re-run
`npm run install-host` and reload the extension. A Chrome restart may be
needed for native-host manifest changes to take effect.

**"Specified native messaging host not found" in the service-worker console.**
Chrome silently treats a host manifest as unfindable if it fails validation.
Modern Chrome **requires the `description` field** in the manifest JSON — the
installers in this repo always write it, but if you hand-roll a manifest,
include it. Also verify the registry value
(`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webmcp.tools.host` on
Windows) points at the generated manifest and that `allowed_origins` matches
your extension ID.

**Paths with spaces (Windows).**
Quote them properly and prefer forward slashes in JSON configs:
`"C:/dev/my tools/webmcp-tools/server/dist/index.js"` works everywhere.

**"The MCP server prints logs into my client."**
All server logging goes to **stderr**; stdout carries only MCP JSON-RPC, per
the stdio transport spec. Clients that display stderr (like Claude Desktop's
logs pane) will show them — that is intentional, they are diagnostics.

**E2E specifics.**
`scripts/e2e.mjs` launches a fresh-profile Chrome with
`--remote-debugging-port` and uses CDP **only** to call
`Extensions.loadUnpacked` — the sanctioned replacement for the
`--load-extension` flag, which Chrome removed (dead since Chrome 137+). The
product itself never needs a debugging port for its transport; it attaches
`chrome.debugger` to individual tabs only for trusted input, full-page
screenshots and network capture. If the E2E can't reach
`http://127.0.0.1:<port>/json/version`, something (antivirus, policy) is
blocking the local debugging port. Run the suite with `npm run e2e` (it
builds checks, installs the host idempotently, and cleans up every process
it started).

**Two servers, one hub file.** Only one MCP client instance should use the
server at a time per user: each server run rewrites
`os.tmpdir()/webmcp-tools-hub.json` with its own port/token, and a relay
mid-reconnect will pick up whichever hub wrote last.

**"Evaluating a string as JavaScript violates CSP" — why evaluate uses the
debugger.** `chrome.scripting` cannot run dynamically built code: the
extension's own MV3 CSP blocks `new Function` in ISOLATED worlds, and the
page's CSP blocks it in MAIN worlds. The `evaluate` tool therefore runs over
CDP `Runtime.evaluate` through a momentary `chrome.debugger` attach — you may
see the debugging infobar flash. This is also why `evaluate` cannot target
pages where DevTools (or another extension's debugger) is already attached.

**Console capture on strict-CSP sites.** Page logs are captured by a hook the
extension injects into the page's MAIN world (`lib/console-hook.js`, installed
via `chrome.scripting`, which is exempt from page CSP); it forwards entries to
the content script with `window.postMessage`. This works everywhere; the only
gap is logs emitted *before* the content script starts (i.e., before
`document_start` of the extension), which do not exist in practice.

## Development

```bash
npm test      # server unit tests (runs in server/)
npm run e2e   # full-stack E2E: real Chrome + extension + native host + MCP client
```

| Path | What |
|---|---|
| `extension/` | MV3 Chrome extension (vanilla JS, no build step) |
| `server/` | MCP server + hub + native relay (TypeScript → `dist/`) |
| `installer/` | Native-host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages + automation test pages (static HTML) |
| `scripts/e2e.mjs` | Full-stack E2E harness |
| `docs/` | This guide, `ARCHITECTURE.md`, `PROTOCOL.md` |
| `test/` | E2E test driving real Chrome through the whole stack |
