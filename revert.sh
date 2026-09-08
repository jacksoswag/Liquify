#!/usr/bin/env bash
# Revert to stock Liquify. Removes every extension and snippet added by this
# fork and leaves the Marketplace theme itself untouched.
#
#   bash revert.sh            # remove the extensions (keeps snippets)
#   bash revert.sh --all      # also strip this fork's snippets from Marketplace
set -euo pipefail
CFG_DIR="$(spicetify path userdata 2>/dev/null | tail -1)"
[ -d "$CFG_DIR" ] || { echo "could not locate spicetify userdata"; exit 1; }
echo "spicetify config: $CFG_DIR"

rm -f "$CFG_DIR/Extensions/liquify-perf.js" \
      "$CFG_DIR/Extensions/liquify-ui-tweaks.js" \
      "$CFG_DIR/Extensions/liquify-glass-gl.js"
sed -i '' 's|^extensions            = .*|extensions            = |' "$CFG_DIR/config-xpui.ini"
sed -i '' 's|^spotify_launch_flags   = .*|spotify_launch_flags   = |' "$CFG_DIR/config-xpui.ini"
sed -i '' 's|^always_enable_devtools = .*|always_enable_devtools = 0|' "$CFG_DIR/config-xpui.ini"
spicetify apply >/dev/null 2>&1
echo "extensions removed and spicetify re-applied"

if [ "${1:-}" = "--all" ]; then
  cat <<'NOTE'

Snippets live in Spotify's IndexedDB, not on disk. To remove them:
  Spotify -> Marketplace -> Snippets, and toggle off any of:
    Dynamic Search Bar (push, not overlap)
    Remove All Scrollbars
    Hide Switch to Video Button
    Hide Playlist Column Header
    Hide Sort By & Add Collaborator
    Hide Add / Mix / Name & Details Row
    Fix Duplicate Playlist Metadata Dots
    Liquid Lyrics Fill Now Playing Panel
    Rotating Cover Art        (this one was modified, not added)
NOTE
fi
echo "restart Spotify to finish."
