#!/bin/sh
# uninstall-host.sh - remove the webmcp-tools native messaging host manifest
# from both the macOS and Linux Chrome locations (missing files are fine).
set -eu

HOST_NAME=com.webmcp.tools.host

MACOS_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
LINUX_MANIFEST="$HOME/.config/google-chrome/NativeMessagingHosts/$HOST_NAME.json"

REMOVED=0
for MANIFEST in "$MACOS_MANIFEST" "$LINUX_MANIFEST"; do
  if [ -f "$MANIFEST" ]; then
    rm -f "$MANIFEST"
    echo "Removed: $MANIFEST"
    REMOVED=1
  else
    echo "Not present (ok): $MANIFEST"
  fi
done

if [ "$REMOVED" -eq 1 ]; then
  echo "webmcp-tools native host uninstalled. You may also remove the unpacked"
  echo "extension from chrome://extensions."
else
  echo "Nothing to uninstall."
fi
