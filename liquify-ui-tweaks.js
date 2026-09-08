// liquify-ui-tweaks — UI removals that CSS cannot express.
//
// Spotify's "Your Library" filter chips are React-Aria [role=option] nodes with
// generated ids (react-aria-1, ...) and no text-, testid- or aria-hook. CSS has
// no text selector, so hiding a specific chip by label has to be done in JS.
//
// Everything else in this setup is a plain CSS snippet; only put things here
// that genuinely need script.

(function liquifyUiTweaks() {
  if (!document.body) return setTimeout(liquifyUiTweaks, 300);

  // Chip labels to remove from the library filter row.
  const HIDE_CHIPS = new Set(['podcasts', 'podcasts & shows', 'shows']);

  const HIDDEN = 'data-lqx-hidden';

  function sweep(root) {
    let boxes;
    try {
      boxes = (root instanceof Element ? root : document)
        .querySelectorAll('[role="listbox"][aria-label="Filter options"], [role="listbox"]');
    } catch { return; }
    for (const box of boxes) {
      for (const opt of box.querySelectorAll('[role="option"]')) {
        if (opt.hasAttribute(HIDDEN)) continue;
        const label = (opt.textContent || '').trim().toLowerCase();
        if (!label) continue;
        if (HIDE_CHIPS.has(label)) {
          opt.setAttribute(HIDDEN, '1');
          opt.style.setProperty('display', 'none', 'important');
        }
      }
    }
  }

  // Chips mount and remount as the library re-renders; a debounced observer on
  // the sidebar keeps them gone without scanning the whole document.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; sweep(document); }, 120);
  };

  sweep(document);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });


  // ---- Liquid Lyrics main-panel desync repair ----
  //
  // The main-view lyrics panel is constructed once and appended to
  // .Root__main-view; its renderer is module-local and never subscribes to
  // Spicetify's "songchange" (the sidebar instance does, which is why the
  // sidebar stays correct while the main panel does not). Two failure modes,
  // both verified with this repair disabled and with all of this setup's CSS
  // removed, so neither is caused by the theme:
  //
  //   blank  - panel mounts without ever getting a frame (launched occluded /
  //            on another Space); the virtualizer measures an empty visible
  //            range and renders 0 lines, forever.
  //   stale  - panel keeps rendering the PREVIOUS track. Measured: playing
  //            "Here Comes Your Man" while the card still read "See You Again".
  //
  // Remounting the panel fixes both. There is no exposed API to re-render it,
  // so the remount goes through the panel's own toggle button; two clicks land
  // back on the state the user was in.

  const LL = { busy: false, attempts: 0, streak: 0, track: null, MAX: 3 };

  const llShownTitle = () =>
    document.querySelector('.ll-song-card-title')?.textContent?.trim() || null;
  const llActualTitle = () => {
    try { return Spicetify?.Player?.data?.item?.name || null; } catch { return null; }
  };

  function lyricsPanelDesynced() {
    if (window.__llNoRepair) return false;
    const panel = document.querySelector('.liquid-lyrics-panel');
    if (!panel || !panel.offsetParent) return false;        // closed / hidden
    const c = panel.querySelector('.liquid-lyrics-content');
    if (!c) return false;
    if (c.getBoundingClientRect().height < 50) return false; // not laid out yet
    if (c.children.length === 0) return true;                // blank
    const actual = llActualTitle();
    const shown = llShownTitle();
    return !!(actual && shown && shown !== actual);          // stale
  }

  async function repairLyrics() {
    if (LL.busy || LL.attempts >= LL.MAX) return;
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.getAttribute('aria-label') === 'Liquid Lyrics');
    if (!btn) return;
    LL.busy = true; LL.attempts++;
    try {
      btn.click();
      await new Promise(r => setTimeout(r, 240));
      btn.click();
      await new Promise(r => setTimeout(r, 420));
    } finally { LL.busy = false; }
  }

  function llTick() {
    const t = llActualTitle();
    if (t !== LL.track) { LL.track = t; LL.attempts = 0; LL.streak = 0; }
    if (lyricsPanelDesynced()) {
      LL.streak++;
      if (LL.streak >= 2) { LL.streak = 0; repairLyrics(); }
    } else {
      LL.streak = 0;
    }
  }

  setInterval(llTick, 900);

  // React to track changes promptly rather than waiting for the poll. The panel
  // needs a moment to (fail to) update before we judge it desynced.
  try {
    Spicetify?.Player?.addEventListener?.('songchange', () => {
      LL.attempts = 0; LL.streak = 0;
      setTimeout(() => { if (lyricsPanelDesynced()) repairLyrics(); }, 1200);
    });
  } catch {}

  window.liquifyLyricsRepair = { state: LL, check: lyricsPanelDesynced, repair: repairLyrics,
                                 shown: llShownTitle, actual: llActualTitle };

  window.liquifyUiTweaks = { sweep, HIDE_CHIPS };
})();
