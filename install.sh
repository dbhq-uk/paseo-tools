#!/bin/bash
# Install the skills in this repository into ~/.claude/skills/ as live symlinks.
#
# SKILL.md references scripts via ${CLAUDE_SKILL_DIR}, which Claude Code
# substitutes to the skill's own directory for personal, project, and plugin
# installs alike. So this script symlinks each whole skill directory into
# ~/.claude/skills/ - every edit (scripts AND SKILL.md) is immediately live,
# with no per-file rewrite. Re-run only when you add a new skill directory.
#
# Paseo plugins under plugins/ are not installed here. Use `paseo plugin install`.
#
# Nothing is installed besides the links. The skills use the Python standard
# library only, so the system python3 runs them under every install shape.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_ROOT="$HOME/.claude/skills"

echo "=== paseo-tools skill installer (Claude Code) ==="
echo

# --- Dependencies ---
# 3.9 is the floor: the scripts carry `from __future__ import annotations`.
if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing required dependency: python3"
  echo "  macOS:  brew install python"
  echo "  Ubuntu: sudo apt install python3"
  exit 1
fi
if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"; then
  echo "Error: Python 3.9+ required, found $(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  exit 1
fi
echo "Dependencies OK."
echo

# --- Install each skill in this repo as a full-directory symlink ---
mkdir -p "$SKILLS_ROOT"
for src in "$SCRIPT_DIR"/skills/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  target="$SKILLS_ROOT/$name"
  echo "Installing '$name' -> $target"
  rm -rf "$target"            # replace any prior copy or partial-symlink install
  ln -sfn "$src" "$target"    # whole-directory symlink; ${CLAUDE_SKILL_DIR} resolves it
  chmod +x "$src"/scripts/*.py "$src"/scripts/*.sh 2>/dev/null || true
done

echo
echo "Installed as directory symlinks - all edits (scripts and SKILL.md) are live. Re-run only when adding a new skill."
echo

# --- Check the machine ---
if command -v tailscale >/dev/null 2>&1; then
  echo "tailscale found. ferry needs 'tailscale serve' to be allowed (sudo -n, or: sudo tailscale set --operator=\$USER)."
else
  echo "tailscale not found. ferry needs it to reach the Paseo browser; --no-tailscale still works on this machine."
fi

echo
echo "Done. Try: 'ferry: get this page data onto the server'"
