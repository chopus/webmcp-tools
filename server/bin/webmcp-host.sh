#!/bin/sh
# webmcp-browser native messaging host launcher (macOS/Linux).
# Re-launches the built relay with --native-host; exec propagates the exit code.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
# Chrome launches native hosts with a minimal PATH; resolve node explicitly
# when it is not on it (user-local installs like ~/.local/bin, Homebrew).
NODE_BIN=$(command -v node 2>/dev/null) || NODE_BIN=""
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
[ -n "$NODE_BIN" ] || { echo "webmcp-host: node not found in PATH or fallback locations" >&2; exit 1; }
exec "$NODE_BIN" "$DIR/../dist/index.js" --native-host
