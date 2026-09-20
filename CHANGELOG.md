# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `evaluate` `unfreeze: true`: activates a Chrome-frozen/discarded tab (Memory Saver), waits for the thaw/reload, then evaluates. Without it, debugger-backed tools now fail fast with `ETAB_FROZEN` instead of hanging into a bare timeout.
- `watch_console` tool: explicitly attaches console capture to a tab the agent has not driven (e.g. one the user already had open); capture starts at the call.
- `webmcp-call.mjs` (skill CLI): `--function-file <path>`, `--args-file <path>`, and positional `-` (stdin) for `evaluate` args — no more shell-JSON escaping for real functions.
- Flow recipe `flows/reddit-extension-smoke.json` (+ `flows/lib/reddit-pill-count.js`): one-command regression smoke test for extensions that inject controls into Reddit posts (shadow-root piercing count, click, screenshot).

### Changed

- `evaluate` timeouts now carry a diagnosis: tab frozen vs. tab inactive vs. the script itself still running (infinite loop / never-settling promise).
- Debugger attach failures are classified and bounded (5 s): a DevTools conflict — including a stalled attach that previously surfaced as a generic 10 s timeout — fails fast with `EDEBUGGER` naming DevTools as the cause.
- Server-side hub timeout for `evaluate` is raised to at least 45 s whenever `unfreeze: true` is set (a thaw + reload alone can take ~25 s).

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
