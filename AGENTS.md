# AGENTS.md

Guidance for AI agents working in this repository or driving the browser
through the webmcp-tools server.

## What this project is

An MCP server that drives the user's **real Chrome** (their profile,
cookies, logins) through an MV3 extension + native messaging host. No
Playwright, no Selenium, no headless browser, no debugging port. The server
speaks classic automation tools **and** WebMCP (page-exposed tools via
`document.modelContext`). Read `docs/ARCHITECTURE.md` for the full design
and `docs/PROTOCOL.md` for tool contracts.

## Repo conventions

- `server/` is TypeScript (`npm run build` → `server/dist/`, `npm test`).
  `extension/` is plain JavaScript with **no build step** — keep it
  dependency-free and readable.
- **Error ergonomics are a project priority:** fail fast, name the cause
  and the fix in the error (`ETAB_FROZEN`, `EDEBUGGER`, …). Never surface
  a bare timeout when a cause is knowable.
- `reports/` is git-ignored (audit logs, run artifacts, user data such as
  IPs). Never commit or publish its contents.
- The extension ID is pinned by the committed `key` in
  `extension/manifest.json`; `key.pem` stays at the repo root, git-ignored.

## Driving the browser without disturbing the user

Verified live 2026-09-27 (Chrome 153). Full details:
`docs/USAGE.md#background-tabs-and-window-visibility`.

- **Always pass an explicit `tabId`.** The default target is the *active*
  tab — whatever the user is watching.
- **Background tabs support everything except screenshots:** DOM-mode
  input, `evaluate`, console/network capture, snapshots, cookies, uploads,
  WebMCP. Open them with `new_tab {"active": false}` and close them when
  done.
- **Trusted input (`trusted: true`) works on background tabs only while
  the Chrome window is actually rendered.** A window covered by a
  fullscreen app or minimized drops the input *silently* — the tool
  reports `clicked: true`, zero DOM events reach the page. If the user is
  gaming, stick to DOM mode.
- **Screenshots (viewport and `fullPage`) need the target tab to be the
  active tab.** Verify background tabs with `snapshot` / `get_page_text` /
  `get_console_logs` / `get_network_requests` instead.
- Never call `activate_tab`, `unfreeze: true`, `new_window`, or
  `resize_window` on the user's window while they work — they move focus.
  A frozen background tab (`ETAB_FROZEN`) is better re-opened than thawed.
- Treat `get_cookies` output as secrets. Honor the origin policy
  (`ECONFIRM_REQUIRED` → ask the user before `confirm: true`).
