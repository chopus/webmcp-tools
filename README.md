# webmcp-tools

A fully featured [MCP](https://modelcontextprotocol.io) server that lets AI agents drive
**your real Chrome browser** — your actual profile, cookies, logins and tabs. No
Playwright, no Selenium, no headless browser.

It combines two ideas:

1. **Full browser automation** through a Chrome extension + native messaging bridge:
   tabs, navigation, snapshots, clicks, typing, scrolling, screenshots, JS evaluation,
   console logs and network capture — executed in your real session.
2. **[WebMCP](https://webmachinelearning.github.io/webmcp/)**: agents can discover and
   call structured tools that web pages expose via `document.modelContext` (imperative)
   and declarative `form[toolname]` — the page-actuation API that replaces brittle
   simulated clicks when available.

> 🚧 Status: under construction. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
> the design and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the bridge contract.

## Layout

| Path | What |
|---|---|
| `extension/` | MV3 Chrome extension (vanilla JS, no build step) |
| `server/` | MCP server + native relay + hub (TypeScript) |
| `installer/` | Native messaging host installers (Windows / macOS / Linux) |
| `demos/` | WebMCP demo pages + automation test pages |
| `scripts/` | Repo tooling (extension key, icons, E2E runner) |
| `test/` | E2E tests driving real Chrome through the whole stack |

## License

MIT (vendored WebMCP polyfill from GoogleChromeLabs is Apache-2.0, kept with header).
