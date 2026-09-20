#!/usr/bin/env bash
# Snapshot the theme's settings-panel choices (and Liquid Lyrics') out of the
# running Spotify into settings.json, so install.sh can seed them back after
# Spotify wipes its browser storage (which it did on 2026-09-14).
#
# They live in the renderer's localStorage, which is only reachable through
# the devtools protocol, so Spotify has to be running with the port open:
#
#   osascript -e 'quit app "Spotify"'; open -a Spotify --args --remote-debugging-port=9222
#
# Keys are taken by prefix, minus the ones that are per-launch state rather
# than choices (the last cover the background showed, the dynamic accent).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
curl -sf -m 2 localhost:9222/json >/dev/null || { echo "Spotify is not running with --remote-debugging-port=9222"; exit 1; }
node - "$HERE/settings.json" <<'JS'
const out = process.argv[2];
const list = await (await fetch('http://localhost:9222/json')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `
  (() => {
    const keep = k => /^(liquify-|liquid-lyrics)/.test(k) && !/^liquify-(fabric-last-art|custom-color)$/.test(k);
    const o = {};
    for (const k of Object.keys(localStorage).filter(keep).sort()) o[k] = localStorage.getItem(k);
    return o;
  })()` } }));
ws.onmessage = async (m) => {
  const d = JSON.parse(m.data); if (d.id !== 1) return;
  const fs = await import('fs');
  fs.writeFileSync(out, JSON.stringify(d.result.result.value, null, 2) + '\n');
  console.log(`wrote ${Object.keys(d.result.result.value).length} keys to ${out}`);
  ws.close();
};
JS
