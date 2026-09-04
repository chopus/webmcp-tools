# WebMCP Tools — Chrome Extension

A Chrome MV3 extension (vanilla JavaScript, classic scripts, no build step, no
npm) that lets AI agents drive **your real Chrome session** — real profile,
cookies, logins, tabs — through the WebMCP Tools MCP server. It speaks the
bridge protocol from [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) over Chrome
native messaging.

## What it does

- **Tabs & navigation**: list/open/activate/close tabs, navigate, reload, back/
  forward, wait for text or selectors.
- **Observation**: interactive-element snapshots with stable `ref`s, page
  text, links, screenshots (visible tab or full page).
- **Interaction**: click / type / press key / hover / scroll / select /
  drag — as DOM-mode synthetic events by default, or **trusted** input via
  `chrome.debugger` (CDP `Input.*`) when `trusted: true`.
- **JavaScript**: `evaluate` in the page's MAIN or ISOLATED world.
- **Console & network**: per-tab console ring buffer (fed by the content
  script) and on-demand network capture via the debugger.
- **WebMCP**: discover and call tools pages expose through
  `document.modelContext` (native or polyfilled, including declarative
  `form[toolname]` tools), with optional polyfill injection.

The service worker keeps a native-messaging port open to the local relay
(`com.webmcp.tools.host`), which keeps the worker alive (Chrome >= 116) and
carries requests/responses to and from the MCP server/hub.

## Prerequisites: native messaging host

The extension is useless without the native host + server. Install them from
the repo root:

- **Windows**: `installer/install-host.ps1` (per-user registry key, no admin)
- **macOS / Linux**: `installer/install-host.sh`

The installer registers `com.webmcp.tools.host` pointing at the built server
binary (`server/bin/webmcp-host.cmd|sh`) and pins `allowed_origins` to this
extension's ID.

## Loading the extension (unpacked)

1. Open `chrome://extensions` in Chrome (116 or newer).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Keep the folder in place — Chrome loads resources from it directly.

Once loaded, the extension immediately tries to connect to the native host;
if the MCP server is not running yet it retries with backoff (1s, 2s, 5s,
10s … capped at 30s). The connection becomes active as soon as the hub is up.

## Extension ID is pinned

`manifest.json` contains a `"key"` field generated from `extension/key.pem`
(run `node scripts/ensure-key.mjs` in the repo root to verify). This pins the
extension ID to `hfjklocnlekmbgcollomhcploljheghf` regardless of which machine
loads the folder unpacked, so the native-host manifest's `allowed_origins`
stays valid. **Do not remove the `key` field or delete `key.pem`** — either
would change the extension ID and break native messaging.

## Layout

```
manifest.json                 MV3 manifest (classic service worker)
background/service-worker.js  entry point: importScripts the libs, connects
                              the native port at top level
background/lib/               service-worker libraries (classic scripts)
  util.js                     errors, param validation, key parsing
  native-port.js              connectNative + backoff + extensionHello
  router.js                   tool name -> handler map (all 27 tools)
  tabs.js                     tab resolution/serialization/nav waiting
  content-bridge.js           content-script ping/inject/ask plumbing
  console-buffer.js           per-tab console ring buffer (1000)
  cdp.js                      chrome.debugger: trusted input, full-page
                              screenshots, network capture
  screenshot.js               captureVisibleTab + downscale/size guard
  webmcp.js                   WebMCP discovery/execution (MAIN world)
  automation.js               interaction tools + evaluate
content/content.js            content script (single classic IIFE)
lib/webmcp-polyfill.js        vendored WebMCP polyfill (Apache-2.0,
                              GoogleChromeLabs/webmcp-tools)
```

## Notes

- All automation runs only in the top frame; `ref`s come from `snapshot` and
  stay valid until the tab navigates.
- `trusted: true` tools briefly show Chrome's "is being debugged" infobar
  while the debugger is attached; it detaches immediately after the action.
