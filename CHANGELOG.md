# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
