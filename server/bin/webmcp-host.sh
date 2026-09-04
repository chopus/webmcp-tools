#!/bin/sh
# webmcp-browser native messaging host launcher (macOS/Linux).
# Re-launches the built relay with --native-host; exec propagates the exit code.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec node "$DIR/../dist/index.js" --native-host
