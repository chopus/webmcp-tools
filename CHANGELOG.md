# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- HTTP transport authentication (`--http`): every request must present `Authorization: Bearer <token>` or `?token=<token>`; unauthenticated requests get a 401 whose message names the fix. The token is the value of `--http-token` / `WEBMCP_HTTP_TOKEN`, or generated at startup and written to a 0600 discovery file (`WEBMCP_HTTP_FILE`, default `<tmpdir>/webmcp-tools-http.json`, removed on shutdown — same pattern as the hub discovery file). Local same-user helpers (the skill CLI) read it automatically, so zero-setup behavior is unchanged; other local users and port scans can no longer drive the browser. Previously the endpoint accepted unauthenticated requests from any local process.

## [0.3.1] - 2026-10-02

Error-reporting ergonomics from the 2026-09-20 Chrome-extension debugging session — capability was fine, round trips were lost to unnamed errors — plus a macOS native-host launcher fix.

### Added

- `evaluate` `unfreeze: true`: activates a Chrome-frozen/discarded tab (Memory Saver), waits for the thaw/reload, then evaluates. Without it, debugger-backed tools now fail fast with `ETAB_FROZEN` instead of hanging into a bare timeout.
- `watch_console` tool: explicitly attaches console capture to a tab the agent has not driven (e.g. one the user already had open); capture starts at the call.
- `webmcp-call.mjs` (skill CLI): `--function-file <path>`, `--args-file <path>`, and positional `-` (stdin) for `evaluate` args — no more shell-JSON escaping for real functions.
- Flow recipe `flows/reddit-extension-smoke.json` (+ `flows/lib/reddit-pill-count.js`): one-command regression smoke test for extensions that inject controls into Reddit posts (shadow-root piercing count, click, screenshot).

### Changed

- `evaluate` timeouts now carry a diagnosis: tab frozen vs. tab inactive vs. the script itself still running (infinite loop / never-settling promise).
- Debugger attach failures are classified and bounded (5 s): a DevTools conflict — including a stalled attach that previously surfaced as a generic 10 s timeout — fails fast with `EDEBUGGER` naming DevTools as the cause.
- Server-side hub timeout for `evaluate` is raised to at least 45 s whenever `unfreeze: true` is set (a thaw + reload alone can take ~25 s).

### Fixed

- Native host launcher (`server/bin/webmcp-host.sh`) resolves node from `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` when Chrome's minimal PATH lacks it (macOS user-local installs exited 127 → "Native host has exited"), and fails with a clear message when node is nowhere; the launcher is now committed executable (mode 755).
- SKILL.md's macOS example path no longer hardcodes a personal username.

## [0.3.0] - 2026-09-17

### Added

- Origin policy tools (`get_origin_policy`/`set_origin_policy`) with allow/deny lists and confirm-required submits on sensitive origins.
- Audit log of agent actions (`reports/audit/*.ndjson`).
- Native dialog tools `get_dialog`/`handle_dialog` with `autoDismiss`.
- `wait_for` element states (visible/hidden/enabled/disabled/editable) and `networkIdle`.
- Coordinate clicks (`click` with `x`/`y`).
- `upload_file` via CDP `DOM.setFileInputFiles`.
- `list_downloads` tracking of Chrome downloads.
- Cross-frame (`all_frames`) snapshot and interaction reach, with per-frame ref mapping.
- Shadow DOM piercing in snapshot and lookup.
- Window tools: `list_windows`, `new_window`, `resize_window`.
- HTTP streamable MCP transport (`--http`, multi-client).
- REST example queue persistence to disk (`data/jobs.jsonl` + `data/pending.json`, replayed on restart).
- CI workflow (GitHub Actions: server build + tests).

### Changed

- `wait_for` default timeout raised to 30000 ms.
- PROTOCOL.md gains §8.
