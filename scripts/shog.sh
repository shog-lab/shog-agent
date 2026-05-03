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
for skill_dir in "$SHOG_DIR/container/skills/"*/; do
  [ -f "$skill_dir/SKILL.md" ] && SKILL_ARGS+=(--skill "$skill_dir")
done
for skill_dir in "$GROUP_DIR/skills/"*/; do
  [ -f "$skill_dir/SKILL.md" ] && SKILL_ARGS+=(--skill "$skill_dir")
done

pi --extension "$SHOG_DIR/container/extensions/memory" \
   --extension "$SHOG_DIR/container/extensions/understand_image" \
   --extension "$SHOG_DIR/container/extensions/web_search" \
   "${SKILL_ARGS[@]}" \
   --append-system-prompt "$(cat "$SHOG_DIR/container/system-prompt.md")" \
   --append-system-prompt "$(cat "$GROUP_DIR/AGENTS.md")"
PI_EXIT=$?

# Archive L3 session files to group raw/sessions/
# Runs on normal exit AND on SIGINT (Ctrl+C)
SESSION_SRC="$HOME/.pi/agent/sessions"
SESSION_DEST="$SHOG_DIR/groups/$GROUP/raw/sessions"
archivate_sessions() {
  if [ -d "$SESSION_SRC" ]; then
    mkdir -p "$SESSION_DEST"
    for f in "$SESSION_SRC"/*.jsonl; do
      [ -f "$f" ] || continue
      cp "$f" "$SESSION_DEST/"
    done
  fi
}
trap archivate_sessions EXIT INT TERM

exit $PI_EXIT
