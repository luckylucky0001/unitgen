#!/bin/sh
# macOS/Linux. Preserve the complete Skill directory, including relative references.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN_DIR="${UNITGEN_BIN_DIR:-$HOME/.local/bin}"
case "${1:-}" in
  --project)
    [ "$#" -eq 2 ] || { echo "usage: $0 --project <existing-project> | --global" >&2; exit 1; }
    PROJECT=$(CDPATH= cd -- "$2" && pwd)
    SKILLS="$PROJECT/.trae/skills"
    ;;
  --global)
    [ "$#" -eq 1 ] || exit 1
    SKILLS="$HOME/.trae-cn/skills"
    ;;
  *) echo "usage: $0 --project <existing-project> | --global" >&2; exit 1 ;;
esac
# Check both destinations before installing either; never replace a user's files.
for DEST in "$SKILLS/unitgen" "$BIN_DIR/unitgen"; do
  if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    case "$DEST" in "$SKILLS/unitgen") EXPECT="$ROOT/skills/unitgen" ;; *) EXPECT="$ROOT/bin/unitgen" ;; esac
    if [ ! -L "$DEST" ] || [ "$(readlink "$DEST")" != "$EXPECT" ]; then
      echo "unitgen: refusing to replace existing $DEST" >&2; exit 1
    fi
  fi
done
mkdir -p "$SKILLS" "$BIN_DIR"
[ -L "$SKILLS/unitgen" ] || ln -s "$ROOT/skills/unitgen" "$SKILLS/unitgen"
[ -L "$BIN_DIR/unitgen" ] || ln -s "$ROOT/bin/unitgen" "$BIN_DIR/unitgen"
printf 'Skill: %s\nCLI: %s\n' "$SKILLS/unitgen" "$BIN_DIR/unitgen"
printf 'Add %s to PATH for TRAE, or set UNITGEN to the absolute CLI path. Keep this checkout in place.\n' "$BIN_DIR"
