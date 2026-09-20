# webmcp-browser tool catalog

Every tool accepts an optional `tabId` (default: the active tab) and an
optional `instanceId` (select one connected browser; without it the most
recently connected browser answers). Interaction tools take **exactly one**
of `ref` (int, from `snapshot`; valid until the tab navigates) or `selector`
(CSS). Submits on origins the origin policy marks sensitive require
`confirm: true` (`ECONFIRM_REQUIRED`).

Error codes: `ETAB_NOT_FOUND | ENO_SUCH_REF | ENO_SUCH_SELECTOR | ETIMEOUT |
EEXECUTION | EDEBUGGER | EWEBMCP | EARGS | ENAVIGATION | EORIGIN_POLICY |
ECONFIRM_REQUIRED | EUPLOAD | ETAB_FROZEN`. Canonical (possibly newer) source
inside the repo: `docs/PROTOCOL.md` and `docs/USAGE.md`.

## Browser & tabs

| Tool | Params | Result |
|---|---|---|
| `get_browser_info` | — | `{ chromeVersion, userAgent, platform, extensionVersion, instanceId, instances: [{ instanceId, … }] }` |
| `list_tabs` | — | `{ tabs: Tab[] }` across all windows |
| `new_tab` | `url` (default `about:blank`), `active` (default `true`), `windowId` | `{ tab: Tab }` |
| `activate_tab` | `tabId` **required** | `{ tab: Tab }` (also focuses its window) |
| `close_tab` | `tabId` **required** | `{ closed: true }` |
| `list_windows` | — | windows with id, state, bounds |
| `new_window` | `url`, `width`, `height` | `{ window }` |
| `resize_window` | `windowId`, `width`/`height` or `state` (`maximized`\|`minimized`\|`normal`) | `{ window }` |

## Navigation

| Tool | Params | Result |
|---|---|---|
| `navigate` | `url` **required**, `timeoutMs` (default `30000`) | `{ tabId, url, title }` — resolves on load complete |
| `go_back` / `go_forward` | `timeoutMs` (default `15000`) | `{ tabId, url, title }` — `navigated: false` at history edges |
| `reload` | `bypassCache` (default `false`), `timeoutMs` (default `30000`) | `{ tabId, url, title }` |
| `wait_for` | exactly one of `text` / `selector` / `networkIdle`; `state` (`visible`\|`hidden`\|`enabled`\|`disabled`\|`editable`, needs `selector`); `idleMs` (default `500`, needs `networkIdle`); `timeoutMs` (default `30000`) | `{ found, matched, tabId, url, title }` — polls ~250 ms |

## Observation

| Tool | Params | Result |
|---|---|---|
| `snapshot` | `maxElements` (default `800`), `viewportOnly` (default `false`) | Readable lines `[ref] tag "text" (role, value…)` + JSON appendix: `viewport`, `elements[]` (`ref`, `tag`, `role`, `text`, `rect`, `visible`, …), `truncated`. Merges all frames; pierces open shadow roots. |
| `get_page_text` | `maxChars` (default `20000`) | `{ tabId, url, title, text, truncated }` — `innerText` of `<body>` |
| `get_links` | — | `{ links: [{ text, href, internal }] }` — first 300 anchors |
| `screenshot` | `format` (`"png"` default \| `"jpeg"`), `quality` (default `80`), `fullPage` (default `false`), `maxWidth` (default `1600`) | MCP image content (base64) + `{ format, width, height }` |

## Interaction

| Tool | Params | Result |
|---|---|---|
| `click` | `ref`/`selector`, or `x`+`y` (viewport coords, trusted CDP input); `button` (`left` default), `clickCount` (default `1`), `modifiers`, `trusted` (default `false`), `timeoutMs` (default `5000`) | `{ clicked: true, tag, text? }` |
| `type_text` | `ref`/`selector`, `text` **required**, `clearFirst` (default `true`), `submit` (default `false`), `confirm?`, `trusted`, `timeoutMs` (default `10000`) | `{ typed: true }` — React-safe value setting, per-char keys |
| `press_key` | `key` **required** (`Enter`, `Tab`, `Escape`, `ArrowDown`, `a`, `Control+A`, …), `ref`/`selector`, `confirm?`, `trusted`, `timeoutMs` | `{ pressed: true }` |
| `hover` | `ref`/`selector` **required**, `timeoutMs` | `{ hovered: true }` |
| `scroll` | `direction` (default `"down"`), `amount` (default `600`), `ref`/`selector` (element scroll), `smooth` (default `true`) | `{ scrollX, scrollY }` |
| `select_option` | `ref`/`selector` **required**, exactly one of `value`/`label`/`index`, `timeoutMs` | `{ selected: string[] }` — fires `input` + `change` |
| `drag` | `fromRef`/`fromSelector` and `toRef`/`toSelector` **required**, `trusted`, `timeoutMs` (default `8000`) | `{ dragged: true }` |
| `upload_file` | `ref`/`selector`, `path` **required** (absolute local path), `timeoutMs` | `{ uploaded: true }` — CDP `DOM.setFileInputFiles`, no file picker |
| `list_downloads` | — | downloads (state, url, filename, bytes, times), newest first |

## JavaScript

| Tool | Params | Result |
|---|---|---|
| `evaluate` | `function` **required** (`"(args) => …"`, may return a promise), `args` (default `{}`), `world` (`"MAIN"` default \| `"ISOLATED"`), `awaitPromise` (default `true`), `unfreeze` (default `false`; the server-side timeout floor becomes 45000 ms when set), `timeoutMs` (default `10000`) | `{ result }` — JSON-serializable values only; non-serializable → `{ result: null, exception: "non-serializable result" }`. Runs via CDP; page CSP cannot block it; cannot run while DevTools is attached to the tab (→ `EDEBUGGER` naming DevTools). A frozen/discarded background tab fails fast with `ETAB_FROZEN` instead of hanging — pass `unfreeze: true` to activate it first (steals focus in its window). Timeouts carry a diagnosis: tab frozen vs. tab inactive vs. script still running. |

## Console & network

| Tool | Params | Result |
|---|---|---|
| `watch_console` | — | `{ watched: true, tabId, note }` — attaches console capture to a tab explicitly (e.g. one the user already had open); capture starts at this call, earlier logs are not recoverable |
| `get_console_logs` | `levels` (default all), `lastN` (default `200`) | `{ logs: [{ ts, tabId, level, text }] }` — ring buffer 1000/tab, cleared on navigation; also attaches capture on first read (`watch_console` does it upfront) |
| `get_network_requests` | `urlContains`, `lastN` (default `50`) | `{ requests: [{ ts, method, url, status, type }] }` — ring buffer 500/tab; capture starts with the first call |
| `stop_network_capture` | — | `{ stopped: true }` |
| `get_cookies` | `url` (instead of the tab URL) | `{ cookies: [{ name, value, domain, path, httpOnly, secure, sameSite, session, expires? }] }` — includes HttpOnly session credentials; treat as secrets |

## WebMCP

| Tool | Params | Result |
|---|---|---|
| `list_webmcp_tools` | `injectPolyfill` (default `false`) | `{ supported, mode: "native"\|"polyfill"\|"declarative"\|"none", tools: [{ name, title?, description?, inputSchema?, annotations? }] }` |
| `call_webmcp_tool` | `name` **required**, `args` (default `{}`), `timeoutMs` (default `30000`) | `{ ok: true, result }`; failures → `EWEBMCP` |

## Policy & dialogs

| Tool | Params | Result |
|---|---|---|
| `get_origin_policy` / `set_origin_policy` | policy: `mode` (`allow`/`deny`), `patterns[]` (`*.example.com`), `sensitive[]` | current policy. Action tools are blocked on denied origins (`EORIGIN_POLICY`); submits on sensitive origins require `confirm: true`. |
| `get_dialog` | — | the open `alert`/`confirm`/`prompt`/`beforeunload` on the tab, and starts watching it |
| `handle_dialog` | `accept`, `promptText?`, or `autoDismiss: true` per tab | `{ handled: true }` |

## Flow runner quick reference

`npm run flow -- flows/<file>.json --var name=value` (repeatable `--var`;
also `--out-dir`, `--instance-id`, `--browser-timeout-ms`). Exit 0 = all
required steps passed. Reports: `reports/<flow>-<ts>.html` + `.json`.

Flow file: `{ name, description, vars, steps: […], finally: […] }`. Step
fields: `name`, `tool`, `args` (with `{{var}}` / `{{saved.path}}` templates,
`{{var|uri}}` URI-encodes; a string that is exactly one template keeps its
type), `functionFile` (for `evaluate`: load the page-side function from a JS
file), `expect` (assertions), `retries`, `retryDelayMs`, `timeoutMs`, `save` /
`saveFrom` (store the result — or the sub-path — as a variable), `when`
(condition on variables), `optional` (failure → `SOFT`, flow continues).

Assertion: `{ "path": "result.count", "op": "gte", "value": 1 }` with dot
paths and array indices (`result.results.0.title`). Operators: `exists`,
`equals`, `notEquals`, `contains`, `matches` (+`regex`), `in`, `gt`, `gte`,
`lt`, `lte`, `type`, `lengthGte`, `lengthLte`. Step statuses: `PASS`, `FAIL`
(stops the flow; `finally` still runs), `SOFT`, `SKIP`.
