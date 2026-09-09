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


  // ---- open in fullscreen ----
  //
  // Spotify ignores --start-fullscreen (verified: the window comes back in
  // "normal" state), and Spicetify's spotify_launch_flags are only applied when
  // Spicetify itself launches the client, not when it is opened from the Dock.
  // The only path left from inside the app is the HTML fullscreen API, and that
  // is gated on a user gesture -- calling it at boot fails with "Permissions
  // check failed". So it is armed here and fires on the first click or keypress
  // after launch, which in practice is the first thing the user does anyway.
  const FS_KEY = 'liquify-open-fullscreen';   // 'on' | 'off' (default off)
  if (localStorage.getItem(FS_KEY) === 'on') {
    const goFull = () => {
      window.removeEventListener('pointerdown', goFull, true);
      window.removeEventListener('keydown', goFull, true);
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', goFull, true);
    window.addEventListener('keydown', goFull, true);
  }
  window.liquifyFullscreen = {
    enable() { localStorage.setItem(FS_KEY, 'on'); return 'on next launch, after your first click'; },
    disable() { localStorage.setItem(FS_KEY, 'off'); return 'off'; },
    now() { return document.documentElement.requestFullscreen?.(); },
  };

  // ---- one settings menu ----
  //
  // Liquify and Liquid Lyrics each render their own settings panel, both React,
  // both mounted in their own overlay. Physically moving one panel's DOM into
  // the other's tree means React can patch or unmount a node that no longer
  // lives where it thinks it does, so instead both keep their own panel and
  // this puts a two-tab switcher at the top of each. One entry point (Liquid
  // Lyrics' settings button), one menu position, either product's real panel.
  const LL_PANEL = '.ll-settings-panel';
  const LQ_PANEL = '.liquifySettingsPanel';
  const LQ_OVERLAY = '#liquify-settings-react-overlay';

  const lqOpen = () => !!document.querySelector(LQ_PANEL);
  const llOpen = () => !!document.querySelector(LL_PANEL);

  // Its own Close button, not the (now hidden) gear: clicking the gear again
  // did not reliably toggle the panel shut, which left both overlays stacked.
  const closeLiquify = () =>
    document.querySelector('.liquifySettingsHeader button[aria-label="Close"]')?.click();
  const closeLyrics = () => { if (llOpen()) document.querySelector('.ll-settings-overlay')?.querySelector('.ll-settings-close, [aria-label*="lose"]')?.click(); };

  // The entry point is relabelled "Liquify settings", so it has to open the
  // Liquify panel; Liquid Lyrics' own settings become the second tab. Liquid
  // Lyrics still owns the only code that can open its panel, so the tab reaches
  // it by clicking the same button with the interceptor temporarily stood down.
  let passThrough = false;
  function openLyricsSettings() {
    passThrough = true;
    document.querySelector('.ll-settings-btn')?.click();
    setTimeout(() => { passThrough = false; }, 0);
  }
  const openLiquifySettings = () => document.getElementById('liquify-settings-gear-btn')?.click();

  // pointerdown and mousedown are intercepted alongside click. Document-capture
  // click already beats a React handler bound on the root container, but a
  // listener bound directly to the button on an earlier phase -- pointerdown,
  // say -- would fire before any click handler at all and open the Lyrics panel
  // regardless. Swallowing all three costs nothing and removes the whole class
  // of failure; only the click actually opens anything.
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    document.addEventListener(type, (e) => {
      if (passThrough) return;
      const btn = e.target?.closest?.('.ll-settings-btn');
      if (!btn) return;
      // capture phase on document, so React's own handler on the root container
      // never sees it
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (type === 'click') openLiquifySettings();
    }, true);
  }

  function buildTabs(active) {
    const bar = document.createElement('div');
    bar.className = 'lqx-settings-tabs';
    for (const [key, label] of [['liquify', 'Liquify'], ['lyrics', 'Lyrics']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lqx-settings-tab' + (key === active ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (key === active) return;
        if (key === 'liquify') { openLiquifySettings(); closeLyrics(); }
        else { closeLiquify(); openLyricsSettings(); }
      });
      bar.appendChild(b);
    }
    return bar;
  }

  function decorate() {
    // rename the entry point; Liquid Lyrics re-renders it, so this is idempotent
    const entry = document.querySelector('.ll-settings-btn');
    if (entry && entry.getAttribute('data-tooltip') !== 'Liquify settings') {
      entry.setAttribute('aria-label', 'Liquify settings');
      entry.setAttribute('title', 'Liquify settings');
      // Liquid Lyrics renders its own tooltip from data-tooltip, so the visible
      // hover label comes from here rather than from aria-label.
      entry.setAttribute('data-tooltip', 'Liquify settings');
    }
    const ll = document.querySelector(LL_PANEL);
    if (ll && !ll.querySelector('.lqx-settings-tabs')) ll.prepend(buildTabs('lyrics'));
    const lq = document.querySelector(LQ_PANEL);
    if (lq && !lq.querySelector('.lqx-settings-tabs')) lq.prepend(buildTabs('liquify'));
  }
  new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
  decorate();

  const settingsStyle = document.createElement('style');
  settingsStyle.id = 'lqx-settings-merge-style';
  settingsStyle.textContent = `
    .lqx-settings-tabs{display:flex;gap:6px;padding:4px 4px 10px;justify-content:center}
    .lqx-settings-tab{appearance:none;border:0;cursor:pointer;padding:5px 16px;border-radius:999px;
      font:600 12px -apple-system,system-ui,sans-serif;color:rgba(255,255,255,.7);
      background:rgba(255,255,255,.08);transition:background .16s ease,color .16s ease}
    .lqx-settings-tab:hover{background:rgba(255,255,255,.14);color:#fff}
    .lqx-settings-tab.active{background:rgba(255,255,255,.22);color:#fff}
    /* Liquify's overlay is positioned for its own gear; centre it like the
       lyrics panel so the two tabs land in the same place on screen */
    ${LQ_OVERLAY} ${LQ_PANEL}{margin:0 auto}`;
  document.head.appendChild(settingsStyle);

  window.liquifyUiTweaks = { sweep, HIDE_CHIPS };
})();
