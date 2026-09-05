# Usage Guide — webmcp-tools

webmcp-tools is an [MCP](https://modelcontextprotocol.io) server. It gives AI
agents full control of your real Chrome browser. The agent uses the profile,
cookies, logins, and tabs that you already have. A small extension and a
native messaging host connect the server to the browser.

The server does classic automation. It opens tabs, navigates, clicks, types,
scrolls, takes screenshots, runs JavaScript, and reads console logs and
network traffic. The server is also WebMCP-aware. It can discover and call
structured tools that pages expose through `document.modelContext`. This
covers imperative and declarative tools.

For the design, read [`ARCHITECTURE.md`](ARCHITECTURE.md). For the wire
contract, read [`PROTOCOL.md`](PROTOCOL.md).

---

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuring an MCP client](#configuring-an-mcp-client)
- [Tool catalog (28 tools)](#tool-catalog-28-tools)
- [Multiple browsers (instanceId)](#multiple-browsers-instanceid)
- [The two input modes (DOM vs trusted)](#the-two-input-modes-dom-vs-trusted)
- [WebMCP: page-exposed tools](#webmcp-page-exposed-tools)
- [Demos](#demos)
- [Examples](#examples)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20+** | Node 22+ recommended. The E2E harness uses the global `WebSocket`. Node 24 was tested. |
| **Chrome 116+** | Modern MV3 service-worker behavior is required. Chrome 152 was tested. |
| **OS** | Windows, macOS, or Linux. The repository has installers for all three. |

## Installation

Run these commands from the repository root:

```bash
npm install                 # root dev dependencies (MCP client SDK, tooling)
npm --prefix server install # server dependencies
npm run build               # compiles server/ TypeScript → server/dist/
npm run install-host        # registers the native messaging host (HKCU / ~/.config)
```

On Windows, `npm run install-host` runs `installer/install-host.ps1`. On
macOS and Linux, run `sh installer/install-host.sh` instead. The installer:

1. Generates the repo-root `key.pem` if it is missing. It uses
   `scripts/ensure-key.mjs`. Your extension ID is deterministic: the committed
   `key` field in `extension/manifest.json` pins the ID.
2. Writes the native-messaging host manifest. The manifest points at
   `server/bin/webmcp-host.cmd` (Windows) or `server/bin/webmcp-host.sh`
   (macOS/Linux). This launcher starts `server/dist/index.js` with
   `--native-host`.
3. Pins `allowed_origins` to `chrome-extension://<your-id>/`. No other
   extension can talk to your host.

Then load the extension into your normal Chrome. Do this once:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**. Select the `extension/` folder of this repository.

> **Warning: this is your real browser.** The extension runs in your daily
> Chrome. It uses your real profile and your logins. This is the purpose of
> the project. But it also means that the agent can act on any site where you
> are signed in. The bridge talks to `127.0.0.1` only. Data does not leave
> your machine. Read the extension source before you load it.

Finally, add the server to your MCP client (see below). When the MCP client
starts the server, the extension connects to it through the native host
automatically.

## Configuring an MCP client

### Claude Desktop

Edit `claude_desktop_config.json`. On Windows the file is at
`%APPDATA%\Claude\claude_desktop_config.json`. On macOS the file is at
`~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Use the absolute path on your machine. Forward slashes also work on Windows.
Restart Claude Desktop after you save the file.

### Cursor

Create `.cursor/mcp.json` in the project, or edit the global config. Use the
same shape:

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

The MCP client starts the server over stdio. You do not configure an HTTP or
WebSocket endpoint. The hub of the server listens on an ephemeral port on
`127.0.0.1`. Only the native relay may use this port. The relay reads the
token from `os.tmpdir()/webmcp-tools-hub.json`.

## Tool catalog (28 tools)

All parameters are optional unless marked **required**. A tool that accepts
`tabId` targets the active tab of the last-focused window when you omit the
parameter. Interaction tools take **exactly one** of `ref` (from `snapshot`)
or `selector` (CSS). **Every** tool also accepts an optional `instanceId` to
select a connected browser. See
[Multiple browsers](#multiple-browsers-instanceid).

### Browser & tabs

| Tool | Params | Result |
|---|---|---|
| `get_browser_info` | — | `{ chromeVersion, userAgent, platform, extensionVersion, instanceId, instances: [{ instanceId, … }] }` |
| `list_tabs` | — | `{ tabs: Tab[] }` across all windows |
| `new_tab` | `url` (default `about:blank`), `active` (default `true`), `windowId` | `{ tab: Tab }` |
| `activate_tab` | `tabId` **required** | `{ tab: Tab }` (also focuses its window) |
| `close_tab` | `tabId` **required** | `{ closed: true }` |

### Navigation

| Tool | Params | Result |
|---|---|---|
| `navigate` | `url` **required**, `tabId`, `timeoutMs` (default `30000`) | `{ tabId, url, title }` — resolves on `status === "complete"` |
| `go_back` | `tabId`, `timeoutMs` (default `15000`) | `{ tabId, url, title }` (`navigated: false` if there is no history) |
| `go_forward` | `tabId`, `timeoutMs` (default `15000`) | `{ tabId, url, title }` (`navigated: false` if there is no history) |
| `reload` | `tabId`, `bypassCache` (default `false`), `timeoutMs` (default `30000`) | `{ tabId, url, title }` |
| `wait_for` | exactly one of `text` or `selector` **required**, `tabId`, `timeoutMs` (default `10000`) | `{ found, matched: "text"\|"selector"\|"none", tabId, url, title }` — polls about every 250 ms |

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
| `type_text` | `ref`/`selector`, `text` **required**, `tabId`, `clearFirst` (default `true`), `submit` (default `false`; presses Enter after typing), `trusted` (default `false`), `timeoutMs` (default `10000`) | `{ typed: true }` |
| `press_key` | `key` **required** (`Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+A`, …), `ref`/`selector`, `tabId`, `trusted` (default `false`), `timeoutMs` (default `5000`) | `{ pressed: true }` |
| `hover` | `ref`/`selector` **required**, `tabId`, `timeoutMs` (default `5000`) | `{ hovered: true }` |
| `scroll` | `tabId`, `direction` (`"up"`/`"down"`/`"left"`/`"right"`, default `"down"`), `amount` (default `600`), `ref`/`selector` (scrolls that element), `smooth` (default `true`) | `{ scrollX, scrollY }` |
| `select_option` | `ref`/`selector` **required**, exactly one of `value`/`label`/`index`, `tabId`, `timeoutMs` (default `5000`) | `{ selected: string[] }` — fires `input` + `change` |
| `drag` | `fromRef`/`fromSelector` and `toRef`/`toSelector` **required**, `tabId`, `trusted` (default `false`), `timeoutMs` (default `8000`) | `{ dragged: true }` |

### JavaScript

| Tool | Params | Result |
|---|---|---|
| `evaluate` | `function` **required** (`"(args) => …"` — expression or promise), `args` (default `{}`), `tabId`, `world` (`"MAIN"` default \| `"ISOLATED"`), `awaitPromise` (default `true`), `timeoutMs` (default `10000`) | `{ result }` — JSON-serializable values only. A non-serializable value gives `{ result: null, exception: "non-serializable result" }`. |

### Console & network

| Tool | Params | Result |
|---|---|---|
| `get_console_logs` | `tabId`, `levels` (default all), `lastN` (default `200`) | `{ logs: [{ ts, tabId, level, text }] }` — ring buffer of 1000 per tab. A navigation clears the buffer. |
| `get_network_requests` | `tabId`, `urlContains`, `lastN` (default `50`) | `{ requests: [{ ts, method, url, status, type }] }` — attaches `chrome.debugger` and enables `Network`. Ring buffer of 500 per tab. The first call starts the capture. Requests before this call are not in the buffer. |
| `stop_network_capture` | `tabId` | `{ stopped: true }` — detaches the debugger if the capture owns it |
| `get_cookies` | `tabId`, `url` (read cookies for this URL instead of the tab URL) | `{ cookies: [{ name, value, domain, path, httpOnly, secure, sameSite, session, expires? }] }` — reads through a momentary debugger attach. Includes **HttpOnly** cookies such as session credentials. Treat the values as secrets. |

### WebMCP

| Tool | Params | Result |
|---|---|---|
| `list_webmcp_tools` | `tabId`, `injectPolyfill` (default `false`) | `{ supported, mode: "native"\|"polyfill"\|"declarative"\|"none", tools: [{ name, title?, description?, inputSchema?, origin?, annotations? }] }` |
| `call_webmcp_tool` | `name` **required**, `args` (default `{}`), `tabId`, `timeoutMs` (default `30000`) | `{ ok: true, result }` — the JSON result of the tool. Failures surface as `EWEBMCP` errors. |

## Multiple browsers (instanceId)

The hub accepts connections from several browsers at the same time. Your
daily Chrome and your test profiles can connect at once. Each browser gets a
stable `instanceId`. The extension stores this ID in `chrome.storage.local`
as a UUID. Old builds of the extension get a synthetic ID (`conn-N`).

- A tool call without `instanceId` goes to the most recently connected
  browser. If that browser disconnects, the call goes to the remaining
  browser.
- Add `instanceId` to any tool call to select one browser. For example, you
  can drive a test profile while your daily Chrome stays connected.
- `get_browser_info` returns the `instanceId` it answered from. It also
  returns the full `instances[]` list.
- A browser that reconnects replaces its old connection automatically.

## The two input modes (DOM vs trusted)

Each interaction tool works in one of two modes.

- **DOM mode (default, `trusted: false`).** A content script scrolls the
  element into view. Then it dispatches synthetic pointer and keyboard
  events. These events respect the needs of React and Vue. Chrome shows no
  debugger banner in this mode. This mode works on most pages.
- **Trusted mode (`trusted: true`).** The extension attaches `chrome.debugger`
  to the tab. It sends real input events through CDP:
  `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and
  `Input.insertText`. These events are the same as your own input. Use this
  mode on pages that ignore synthetic events. Examples: pages with bot
  detection, canvas games, and drag-and-drop with pointer capture. While the
  debugger is attached, Chrome shows the infobar "webmcp-tools started
  debugging this browser". The extension detaches the debugger when the
  action completes.

The `fullPage` screenshot and the network capture use the same debugger
attach. You may see the infobar for these operations too. This is expected
and safe.

## WebMCP: page-exposed tools

WebMCP lets a page declare tools for agents. The agent calls a structured API
instead of simulating clicks.

- **Imperative:** the page calls
  `document.modelContext.registerTool({ name, description, inputSchema, execute })`.
- **Declarative:** the page writes
  `<form toolname="reserve_table" tooldescription="…">`. The schema comes
  from the form fields. A `toolparamdescription` attribute becomes the
  description of a parameter.

`list_webmcp_tools` inspects a tab in the MAIN world of the page. It reports
what it finds. `call_webmcp_tool` executes one tool by name with JSON
arguments. For a declarative form, the extension fills the fields and submits
the form. The validation and handlers of the page run.

- **Native WebMCP** ships behind an origin trial that starts with Chrome 149.
  For tests, enable it at `chrome://flags/#enable-webmcp-testing`.
- On **stable Chrome**, pass `injectPolyfill: true` to `list_webmcp_tools`.
  The extension then injects the vendored WebMCP polyfill
  (`demos/shared/webmcp-polyfill.js`, also vendored inside the extension)
  into the page before discovery. A page that loads its own polyfill is
  discovered without injection.

To try the demos, serve them with a static server. Run `npx serve demos`, or
run `python -m http.server` from `demos/`. Then ask your agent: *"List the
WebMCP tools on http://localhost:3000/webmcp-store/index.html and add two
espressos to the cart."*

## Demos

| Demo | What it shows |
|---|---|
| `demos/webmcp-store/index.html` | Imperative WebMCP: a coffee and pizza shop registers `search_catalog`, `add_to_cart`, `get_cart`. The human UI and the agent tools share one implementation. |
| `demos/declarative-form.html` | Declarative WebMCP: a restaurant reservation written as `<form toolname="reserve_table">` markup |
| `demos/automation-test.html` | Test page for every classic automation tool (click, double-click, type, select, hover, scroll, keys, console, links) |
| `demos/navigation-target.html` | Pair page for navigate / go_back / go_forward / reload tests |
| `demos/shared/webmcp-polyfill.js` | Vendored WebMCP polyfill (Apache-2.0, © Google LLC) |

## Examples

The scripts in [`examples/`](../examples/) are ready to run. First run
`npm install` at the repository root, build the server, and load the
extension:

| Example | What it shows |
|---|---|
| `examples/google-search.mjs` | Search on the command line in your real browser. The script reads the results, clicks "Next" through a snapshot ref (with URL fallback), and takes a screenshot. Run: `node examples/google-search.mjs "axolotl" 3` |
| `examples/google-search-api.mjs` | REST automation service (Hono). Run `npm run api`. Then send `POST /search {"query":"capybara","pages":2}`. The service controls your Chrome and returns the results as JSON. For a browser it returns a rendered HTML page. Options: `pages`, `screenshot` (data-URL and a copy in `.tmp/`), `instanceId`, `keepTab`. `GET /health` reports connected browsers. `GET /` serves a form that posts and shows the response. A FIFO queue serializes concurrent requests. Search tabs close automatically unless you set `keepTab: true`. |

A full feature tour lives in [`FEATURES.md`](FEATURES.md).

## Security and privacy

- **Localhost only.** The hub listens on `127.0.0.1` on an ephemeral port. A
  random token authenticates the relay. The token file is
  `os.tmpdir()/webmcp-tools-hub.json`. It has owner-only permissions. A clean
  shutdown deletes it. Random local processes cannot impersonate the bridge.
- **Pinned origin.** The `allowed_origins` of the native host manifest
  contains exactly your deterministic extension ID. Other extensions cannot
  connect.
- **No telemetry, no cloud.** Data does not leave your machine. The bridge
  has no analytics and no remote endpoint.
- **The extension has full browser control.** It can use tabs, scripting,
  and the debugger — the same permissions as a password manager. Read
  `extension/` before you load it. The code is small, has no dependencies,
  and reads quickly.
- **`key.pem` stays on your machine.** Git ignores it. The script
  `scripts/ensure-key.mjs` generates it locally. It only pins your extension
  ID. It is not a credential for a remote service. Do not commit it. Keep it
  out of `extension/` — Chrome warns when a key file is inside the extension
  directory.
- **To uninstall:** remove the extension in `chrome://extensions`. Then run
  `npm run uninstall-host` (Windows) or `sh installer/uninstall-host.sh` to
  delete the native host registration. Stop any running MCP server process.
  The hub socket and the token file stop with it.

## Troubleshooting

**`extension_not_connected` from every tool call.**
The extension is not loaded, or the native host is not installed, or the
service worker has not reconnected after a server restart. The extension
retries with backoff for up to 30 s. Wait a moment, or switch the extension
off and on in `chrome://extensions`. Verify the host with
`npm run install-host`. Open `chrome://extensions`, select the extension,
and read the "service worker" console for native-host errors.

**Extension ID mismatch after a change of the manifest `key` field.**
The committed `"key"` field in `extension/manifest.json` pins the extension
ID. If you remove this field, or replace it with a key from a newly generated
repo-root `key.pem`, the ID changes. The installed native host manifest then
does not match. Re-run `npm run install-host` and reload the extension. A
Chrome restart may be necessary after a change of a native-host manifest. A
deleted `key.pem` alone changes nothing.

**"Specified native messaging host not found" in the service-worker console.**
Chrome reports this error when it cannot read or validate the host manifest.
Modern Chrome requires the `description` field in the manifest JSON. The
installers in this repository always write it. If you write a manifest by
hand, include the field. Also check the registry value
(`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webmcp.tools.host` on
Windows). It must point to the generated manifest. Its `allowed_origins`
must match your extension ID.

**Paths with spaces (Windows).**
Quote the paths. Prefer forward slashes in JSON configs:
`"C:/dev/my tools/webmcp-tools/server/dist/index.js"` works everywhere.

**"The MCP server prints logs into my client."**
All server logging goes to **stderr**. Only MCP JSON-RPC uses stdout, as the
stdio transport requires. Clients that show stderr (like the log pane of
Claude Desktop) display these lines. They are diagnostics.

**"Evaluating a string as JavaScript violates CSP" — why `evaluate` uses the
debugger.** `chrome.scripting` cannot run code built at runtime. The CSP of
the extension blocks `new Function` in ISOLATED worlds. The CSP of the page
blocks it in MAIN worlds. Therefore the `evaluate` tool runs over CDP
`Runtime.evaluate` through a momentary `chrome.debugger` attach. You may see
the debugging infobar flash. The same restriction means that `evaluate`
cannot target a tab where DevTools or another debugger is already attached.

**Console capture scope.** The extension injects `lib/console-hook.js` into
the MAIN world of a page with `chrome.scripting`. A page CSP cannot restrict
this injection. The hook sends the entries to the content script with
`window.postMessage`. The hook is installed **only on tabs that the agent
drives** (or on the tab of a `get_console_logs` call). A wrapped console
makes Chrome put the console calls of the page into the error log of this
extension. Therefore the hook does not run on tabs that you browse
passively. Logs emitted before the first agent action on a tab are not
captured.

**E2E specifics.**
`scripts/e2e.mjs` starts a fresh-profile Chrome with
`--remote-debugging-port`. It uses CDP only to call `Extensions.loadUnpacked`.
This call is the supported replacement for the `--load-extension` flag,
which Chrome removed in version 137. The product itself needs no debugging
port. It attaches `chrome.debugger` to single tabs for trusted input,
full-page screenshots, and network capture. If the E2E cannot read
`http://127.0.0.1:<port>/json/version`, something blocks the local debugging
port (antivirus, policy). Run the suite with `npm run e2e`. It verifies the
build, installs the host when necessary, and stops every process it started.

**Two servers, one hub file.** Use only one MCP client at a time per user.
Each server run rewrites `os.tmpdir()/webmcp-tools-hub.json` with its own
port and token. A relay that reconnects connects to the hub that wrote the
file last.

## Development

```bash
npm test      # server unit tests (runs in server/)
npm run e2e   # full-stack E2E: real Chrome + extension + native host + MCP client
```

### Dual-remote workflow (public + private)

The project has a **public** repository and a **private** one for
confidential branches. After a clone, install the push guard once:

```bash
sh scripts/git-hooks/install.sh
```

The guard blocks every push to the public remote that is not
`main -> main`. This includes `main:some-branch` and
`private-branch:main`. The private remote accepts all branches. Add the
private remote after a clone if it is absent:
`git remote add private <url>`. Daily use:

```bash
git push                    # public: main only
git push private main       # sync the private base
git checkout -b secret-x && git push private secret-x   # private work
```
