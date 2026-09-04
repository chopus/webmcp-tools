#!/bin/sh
# install-host.sh - register the webmcp-tools native messaging host for Chrome
# on macOS (~/Library/Application Support/Google/Chrome/NativeMessagingHosts)
# or Linux (~/.config/google-chrome/NativeMessagingHosts).
#
# Usage:
#   sh installer/install-host.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

HOST_NAME=com.webmcp.tools.host

command -v node >/dev/null 2>&1 || {
  echo "error: node was not found in PATH; install Node.js 20+ first" >&2
  exit 1
}

ENSURE_KEY="$REPO_ROOT/scripts/ensure-key.mjs"
[ -f "$ENSURE_KEY" ] || { echo "error: missing $ENSURE_KEY" >&2; exit 1; }

HOST_LAUNCHER="$REPO_ROOT/server/bin/webmcp-host.sh"
[ -f "$HOST_LAUNCHER" ] || { echo "error: missing $HOST_LAUNCHER" >&2; exit 1; }

if [ ! -f "$REPO_ROOT/server/dist/index.js" ]; then
  echo "warning: server/dist/index.js not found; build it first:" >&2
  echo "  cd server && npm install && npm run build" >&2
fi

# Derive the deterministic extension id (key pinned in manifest; repo-root key.pem).
KEY_JSON=$(node "$ENSURE_KEY") || { echo "error: ensure-key.mjs failed" >&2; exit 1; }
EXTENSION_ID=$(printf '%s' "$KEY_JSON" | node -e 'let s="";process.stdin.on("data",d=>{s+=d});process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s).extensionId))}catch(e){process.exit(1)}})')
case "$EXTENSION_ID" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) echo "error: unexpected extension id from ensure-key.mjs: '$EXTENSION_ID'" >&2; exit 1 ;;
esac

chmod +x "$HOST_LAUNCHER"

OS=$(uname -s)
case "$OS" in
  Darwin)
    NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "error: unsupported OS '$OS' (use installer/install-host.ps1 on Windows)" >&2
    exit 1
    ;;
esac

mkdir -p "$NM_DIR"
MANIFEST="$NM_DIR/$HOST_NAME.json"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "WebMCP Tools bridge: connects the Chrome extension to the webmcp-browser MCP server",
  "path": "$HOST_LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "Installed native messaging host '$HOST_NAME' for $OS."
echo "  Extension ID : $EXTENSION_ID"
echo "  Manifest     : $MANIFEST"
echo "  Launcher     : $HOST_LAUNCHER"
echo ""
echo "Next step: open Chrome, go to chrome://extensions, enable Developer mode,"
echo "then 'Load unpacked' and select:"
echo "  $REPO_ROOT/extension"
echo ""
echo "The extension id shown there should be: $EXTENSION_ID"
