#!/bin/bash
# Usage: ./scripts/shog.sh [group-name]
# Default group: dingtalk-shog

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SHOG_DIR="${SHOG_AGENT_DIR:-$PROJECT_DIR}"
GROUP="${1:-dingtalk-shog}"
export GROUP_DIR="$SHOG_DIR/groups/$GROUP"

if [ ! -d "$GROUP_DIR" ]; then
  echo "ERROR: Group not found: $GROUP_DIR" >&2
  exit 1
fi

SKILL_ARGS=()
for skill_dir in "$GROUP_DIR/skills/"*/; do
  [ -f "$skill_dir/SKILL.md" ] && SKILL_ARGS+=(--skill "$skill_dir")
done

pi --extension "$SHOG_DIR/container/extensions/memory" \
   --extension "$SHOG_DIR/container/extensions/web" \
   "${SKILL_ARGS[@]}" \
   --append-system-prompt "$(cat "$GROUP_DIR/AGENTS.md")"
