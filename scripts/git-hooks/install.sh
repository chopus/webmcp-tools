#!/bin/sh
# Install the repo's git hooks (pre-push public/private guard).
set -e
root="$(cd "$(dirname "$0")/../.." && pwd)"
cp "$root/scripts/git-hooks/pre-push" "$root/.git/hooks/pre-push"
chmod +x "$root/.git/hooks/pre-push" 2>/dev/null || true
echo "installed: .git/hooks/pre-push (public remote only accepts main)"
