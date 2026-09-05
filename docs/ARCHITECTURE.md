# Architecture — webmcp-tools

webmcp-tools is an MCP server. It gives AI agents full control of the real
Chrome session of the user. The session includes the real profile, cookies,
logins, and tabs. The project does not use Playwright, Selenium, or a
headless browser. The server also speaks **WebMCP**
([spec](https://webmachinelearning.github.io/webmcp/)). It can discover and
call tools that pages expose through `document.modelContext`, native or
polyfilled. This includes declarative `form[toolname]` tools.

## Why an extension and native messaging?

Chrome 136 and later ignore `--remote-debugging-port` on the default user
profile. Because of this, CDP over DevTools cannot reach the daily Chrome
session of the user. The supported way to instrument the real browser is:

1. A **Chrome extension** loaded (unpacked) in the normal Chrome of the user.
2. A **native messaging host** that Chrome starts for the extension.

This pair gives access to `chrome.tabs`, `chrome.scripting`, and
`chrome.debugger`. All of them operate on the real tabs and profile of the
user.

## Components

```
┌────────────┐ stdio (JSON-RPC/MCP) ┌─────────────────────┐
│ MCP client │◄────────────────────►│ webmcp-browser      │  Node.js process. The MCP
│ (agent,    │                      │ MCP server + hub    │  client starts it (e.g.
│  IDE, CLI) │                      │ server/ (TS)        │  Claude Desktop, Cursor).
└────────────┘                      └──────────┬──────────┘
                                               │ TCP 127.0.0.1:<ephemeral>
                                               │ newline-delimited JSON
                                    ┌──────────▼──────────┐
                                    │ native relay        │  Node.js process. Chrome
                                    │ (same binary,       │  starts it when the
                                    │  --native-host)     │  extension calls
                                    └──────────┬──────────┘  connectNative().
                                               │ native messaging
                                               │ (4-byte LE length-prefixed JSON, stdio)
                                    ┌──────────▼──────────┐
                                    │ Chrome extension    │  MV3 service worker in the
                                    │ extension/ (JS)     │  real Chrome of the user
                                    └──────────┬──────────┘
                                               │ chrome.tabs / chrome.scripting /
                                               │ chrome.debugger (CDP) / captureVisibleTab
                                    ┌──────────▼──────────┐
                                    │ Real tabs (user     │
                                    │  profile, cookies)  │
                                    └─────────────────────┘
```

### Process and transport details

- **One binary, two modes.** `server/dist/index.js` detects its mode:
  - An **MCP client** started the process. Stdin carries line-delimited
    JSON-RPC. The process runs the MCP server and the TCP **hub**. The hub
    listens on `127.0.0.1` on an ephemeral port.
  - **Chrome native messaging** started the process (the argument list
    contains `chrome-extension://…`, or the flag `--native-host` is set).
    Stdin carries length-prefixed frames. The process runs the **relay**.
    The relay converts between native-messaging frames and hub TCP lines.
- **Discovery and authentication.** At startup the hub writes
  `os.tmpdir()/webmcp-tools-hub.json`. The file contains `{ port, token }`
  and has owner-only permissions. A clean shutdown deletes it. The relay
  reads the file, connects, and sends the token in its first `hello`
  message. A wrong or missing token closes the socket. Because of this,
  random local processes cannot impersonate the bridge.
- **Several browsers.** The hub tracks one connection per browser instance.
  The extension sends a stable per-profile `instanceId` (a UUID in
  `chrome.storage.local`) with its `extensionHello`. The same id that
  reconnects replaces its old socket. Different ids coexist. A tool call
  carries an optional `instanceId` to select a browser. Without it, the most
  recently connected instance answers.
- **Native host registration.** `installer/install-host.ps1` (Windows, HKCU,
  no admin) and `installer/install-host.sh` (macOS/Linux) write the
  native-messaging host manifest. The manifest points at
  `server/bin/webmcp-host.cmd|sh`. This launcher restarts the same binary
  with `--native-host`. The installer computes `allowed_origins` at install
  time from the deterministic extension ID. The committed `key` field in
  `extension/manifest.json` pins this ID. The private `key.pem` lives at the
  repository root — Chrome warns when a key file is inside the extension
  directory. The script `scripts/ensure-key.mjs` generates it. Git ignores
  it.
- **Extension-to-server protocol.** See [`PROTOCOL.md`](PROTOCOL.md). It is
  a small request, response, and event envelope over both hops (native
  messaging frame and TCP line).

### Automation strategy — two input modes

- **DOM mode (default):** content scripts resolve element refs and
  selectors, scroll elements into view, and dispatch synthetic pointer and
  keyboard events. Chrome shows no debugger banner. This mode works on most
  pages. A synthetic `click` uses the normal activation behavior of the
  browser: checkboxes toggle exactly once, `preventDefault` is honored, and
  labels forward the click to their control.
- **Trusted mode (`trusted: true`):** the extension attaches
  `chrome.debugger` and sends CDP `Input.dispatchMouseEvent` and
  `Input.insertText`. These are real input events. They are the same as the
  input of the user. Chrome shows its "debugging" infobar while the debugger
  is attached. The extension detaches when it is idle.

`evaluate` also runs over CDP (`Runtime.evaluate` with a momentary debugger
attach). `chrome.scripting` cannot evaluate code built at runtime: the CSP
of the extension blocks `new Function` in ISOLATED worlds, and the CSP of
the page blocks it in MAIN worlds. `world:"ISOLATED"` evaluates in a fresh
isolated world with clean globals and the same DOM.

Console capture: the content script can wrap only the console of its
*isolated world*. Pages never log through it. Therefore the service worker
also injects `lib/console-hook.js` into the **MAIN world** of the page.
This injection is browser-internal, so a page CSP cannot block it. Modern
Chrome no longer runs script elements that isolated worlds insert. A wrapped
console makes Chrome put the console calls of the page into the error log of
the extension, so the hook is installed **only on agent-driven tabs**
(first contact through the content bridge, or a `get_console_logs` call) and
never on tabs the user browses passively. The hook sends `console.*`,
`error`, and `unhandledrejection` entries to the content script with
`window.postMessage`. The content script sends them to the ring buffer of
the service worker.

### WebMCP integration

`list_webmcp_tools` runs in the MAIN world of the page:

1. If `document.modelContext` exists (Chrome 149+ with the WebMCP flag or
   the origin trial), it calls `await document.modelContext.getTools()`.
2. Else, if the page uses the WebMCP polyfill, the tools appear in
   `window.__webmcp_registered_tools` and in declarative `form[toolname]`
   elements. The polyfill also defines `document.modelContext`, so step 1
   usually covers it.
3. With `injectPolyfill: true`, the extension injects the vendored polyfill
   first. Pages written against the API then work on stable Chrome.

`call_webmcp_tool` finds the tool by name and executes it in the MAIN world
with `executeTool`. It returns the JSON result. This is the "WebMCP way" to
drive a page: structured tools replace simulated clicks. All classic
automation tools stay available for pages without tools.

## Repository layout

```
extension/    MV3 Chrome extension (plain JavaScript, no build step)
server/       MCP server + native relay + hub (TypeScript → dist/)
installer/    Native-host installers (Win/macOS/Linux)
demos/        WebMCP demo pages + automation test pages (static HTML)
examples/     Runnable example scripts (google-search.mjs, …)
docs/         ARCHITECTURE.md, PROTOCOL.md, FEATURES.md, USAGE.md
scripts/      Repository tooling (key generation, icons, E2E runner)
test/         E2E test that drives a real Chrome through the full stack
```
