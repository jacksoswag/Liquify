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
  // Liquid Lyrics' main panel is appended INSIDE .Root__main-view, so while it
  // is showing it covers the whole main view. Its renderer never subscribes to
  // "songchange" (the sidebar instance does, which is why the sidebar stays
  // correct), so the panel keeps rendering the PREVIOUS track until remounted.
  //
  // Detecting whether the panel is actually showing is the load-bearing detail,
  // and an earlier version got it wrong with real consequences. The panel keeps
  // offsetParent / display / opacity / visibility IDENTICAL in both states:
  //
  //   dismissed -> position: relative, z-index: auto,  no "visible" class
  //   showing   -> position: absolute, z-index: 100,   has "visible" class
  //
  // Guarding on offsetParent was therefore always true, so the repair clicked
  // the toggle while the panel was dismissed -- re-opening it over the main view
  // and making playlists and albums unreachable. Only the "visible" class is a
  // valid signal, and the repair now refuses to run without it, re-checks it
  // between the two clicks, and restores it afterwards if anything drifted.

  const LL = { busy: false, track: null, attempts: 0, MAX: 2 };
  const LL_OFF_KEY = 'liquify-lyrics-autorepair';           // 'off' disables

  const llPanel = () => document.querySelector('.liquid-lyrics-panel');
  const llShowing = () => !!llPanel()?.classList.contains('visible');
  const llToggle = () => [...document.querySelectorAll('button')]
    .find(b => b.getAttribute('aria-label') === 'Liquid Lyrics');
  const llShownTitle = () =>
    document.querySelector('.ll-song-card-title')?.textContent?.trim() || null;
  const llActualTitle = () => {
    try { return Spicetify?.Player?.data?.item?.name || null; } catch { return null; }
  };

  function llDesynced() {
    if (localStorage.getItem(LL_OFF_KEY) === 'off') return false;
    if (!llShowing()) return false;                 // dismissed: never touch it
    const c = llPanel()?.querySelector('.liquid-lyrics-content');
    if (!c || c.getBoundingClientRect().height < 50) return false;
    if (c.children.length === 0) return true;       // mounted blank
    const a = llActualTitle(), b = llShownTitle();
    return !!(a && b && a !== b);                   // showing the wrong track
  }

  async function repairLyrics(force) {
    if (LL.busy) return 'busy';
    if (!force && !llDesynced()) return 'not desynced';
    const btn = llToggle();
    if (!btn) return 'no toggle';
    const wasShowing = llShowing();
    if (!force && !wasShowing) return 'panel dismissed';
    LL.busy = true;
    try {
      btn.click();
      await new Promise(r => setTimeout(r, 280));
      btn.click();
      await new Promise(r => setTimeout(r, 420));
      // never leave the panel in a state the user did not choose
      if (llShowing() !== wasShowing) { btn.click(); await new Promise(r => setTimeout(r, 260)); }
      return 'remounted';
    } finally { LL.busy = false; }
  }

  try {
    Spicetify?.Player?.addEventListener?.('songchange', () => {
      LL.attempts = 0;
      setTimeout(() => {
        if (LL.attempts < LL.MAX && llDesynced()) { LL.attempts++; repairLyrics(false); }
      }, 1400);
    });
  } catch {}

  window.liquifyLyricsRepair = {
    repair: () => repairLyrics(true),
    showing: llShowing,
    desynced: llDesynced,
    shown: llShownTitle,
    actual: llActualTitle,
    disable() { localStorage.setItem(LL_OFF_KEY, 'off'); return 'auto-repair off'; },
    enable() { localStorage.removeItem(LL_OFF_KEY); return 'auto-repair on'; },
  };

  window.liquifyUiTweaks = { sweep, HIDE_CHIPS };
})();
