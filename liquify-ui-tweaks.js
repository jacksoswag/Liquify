// liquify-ui-tweaks — UI removals that CSS cannot express.
//
// Spotify's "Your Library" filter chips are React-Aria [role=option] nodes with
// generated ids (react-aria-1, ...) and no text-, testid- or aria-hook. CSS has
// no text selector, so hiding a specific chip by label has to be done in JS.
//
// Everything else in this setup is a plain CSS snippet; only put things here
// that genuinely need script.

// ---- Spicetify.Locale, before Spotify gets round to defining it ----
//
// Name That Tune initialises i18n with `Spicetify.Locale.getLocale()` at module
// scope. Navigate to the game and that is fine. Let Spotify RESTORE the game's
// route at launch and its route chunk runs early enough that Spicetify.Locale
// is still undefined, so the app throws at import and the whole page renders as
// "Something went wrong. Try reloading the page." -- which is also why the
// background looked stuck: with the app dead, the reveal panel it is watched
// for never appears.
//
// Extensions are evaluated well before route chunks, so a stand-in here is
// always in place first. Defined as an accessor rather than assigned, so that
// the moment Spotify installs the real Locale it takes over completely and
// nothing is left holding a stub.
(function shimLocaleUntilReady() {
  const S = window.Spicetify;
  if (!S || S.Locale) return;
  let real = null;
  const stub = {
    getLocale: () => S.Platform?.Session?.locale || (navigator.language || 'en').split('-')[0],
  };
  try {
    Object.defineProperty(S, 'Locale', {
      configurable: true,
      get: () => real || stub,
      set: (v) => { real = v; },
    });
  } catch {}
})();

// Liquid Lyrics' settings entry point is not only the button in its card
// header -- it also registers a Spicetify.Menu item in the profile dropdown,
// named "Liquid Lyrics Settings", whose callback opens its own panel directly.
// That path never touches .ll-settings-btn, so the click interceptor further
// down could not see it, and it is why the old name and the Lyrics panel kept
// coming back however many times the button itself was checked.
//
// It is caught at construction rather than in the rendered menu: this file is
// listed before liquid-lyrics.js loads, so the Item class can be wrapped before
// Liquid Lyrics ever calls it, and the item is then born with the right name
// and the right callback -- no rename flash, and nothing to re-apply when the
// menu re-renders. A Proxy is used so every other menu item, and everything
// else about the class, is untouched.
(function patchLiquidLyricsMenuItem() {
  const M = window.Spicetify?.Menu;
  if (!M?.Item) return setTimeout(patchLiquidLyricsMenuItem, 60);
  if (M.Item.__lqxPatched) return;
  const Original = M.Item;
  const openLiquify = () => document.getElementById('liquify-settings-gear-btn')?.click();
  const Patched = new Proxy(Original, {
    construct(target, args) {
      if (args[0] === 'Liquid Lyrics Settings') {
        args = args.slice();
        args[0] = 'Liquify settings';
        // The menu item is a toggle in Liquid Lyrics' hands; here it is a plain
        // action, so the enabled state is left alone and only the panel opens.
        args[2] = () => openLiquify();
      }
      return Reflect.construct(target, args);
    },
  });
  Patched.__lqxPatched = true;
  M.Item = Patched;
})();

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
  // Both selectors. The aria-label is the theme's translated `t.close`, so
  // matching on the English string alone finds nothing on a client running in
  // any of the other eleven languages the theme ships -- and then the Lyrics
  // tab opens Liquid Lyrics without closing Liquify, which is the stacked-panel
  // bug this function exists to prevent.
  const closeLiquify = () =>
    document.querySelector(
      '.liquifySettingsHeader .liquifyCloseBtn, .liquifySettingsHeader button[aria-label="Close"]'
    )?.click();
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
      const btn = e.target?.closest?.('.ll-settings-btn, [data-lqx-settings-entry]');
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
    // Fallback for the profile-menu item, in case Liquid Lyrics managed to
    // register it before the Proxy above was installed. The constructor patch
    // is the real fix; this only catches a load-order race, and marks what it
    // renamed so the click handler below can route it.
    for (const el of document.querySelectorAll('.main-contextMenu-menuItemButton')) {
      if (el.textContent.trim() !== 'Liquid Lyrics Settings') continue;
      const label = [...el.querySelectorAll('*')].find(
        (n) => n.children.length === 0 && n.textContent.trim() === 'Liquid Lyrics Settings') || el;
      label.textContent = 'Liquify settings';
      el.setAttribute('data-lqx-settings-entry', '1');
    }
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
  // ---- Name That Tune: the body classes it forgets on a cold start ----
  //
  // The game conceals the answer entirely through two body classes,
  // `name-that-tune` and `name-that-tune--guessing`: its own stylesheet uses
  // them to blank the play bar's cover, title and artist, the Now Playing
  // view, and the skip buttons.
  //
  // Its extension sets them from a Spicetify History.listen callback and
  // nowhere else. So they are applied when you NAVIGATE to the game, and never
  // when Spotify restores that route at launch -- which it does every time the
  // game was the last thing open. Boot straight into a round and the app
  // renders with none of its own concealment: the play bar names the mystery
  // track, shows its cover, and this theme's background paints its album across
  // the screen. Verified: the answer was legible in the play bar before the
  // first snippet played.
  //
  // Repaired from here rather than in the app, which is a vendored minified
  // bundle any update would overwrite.
  //
  // ADD ONLY. The game removes both classes correctly on its own (classList
  // .toggle with an explicit false removes), so there is nothing to fight over
  // and no window in which this could take the concealment away mid-round --
  // in particular not the one inside nextSong(), which sets the class before
  // React has cleared the previous reveal.
  const NTT_ROUTE = /^\/name-that-tune/;
  const onNttRoute = () => NTT_ROUTE.test(Spicetify.Platform?.History?.location?.pathname || '');
  const nttRevealed = () => !!document.querySelector('.name-that-tune-module__reveal');

  function repairNameThatTune() {
    if (!onNttRoute()) return;
    document.body.classList.add('name-that-tune');
    if (!nttRevealed()) document.body.classList.add('name-that-tune--guessing');
    stripNttTitle();
  }

  // The game's heading is "\u{1F3B5} Name That Tune", with the emoji baked into
  // its translation string rather than rendered as a separate node, so there is
  // nothing for CSS to hide -- it is a leading character of a text node.
  //
  // Done from the DOM rather than by patching the app's i18n: the string is
  // inside a minified bundle any update would replace, and React never reads
  // the DOM back, so the shortened text survives every re-render of the same
  // component. Only a remount brings it back, which is what the observer above
  // is for. Matched by "leading run of non-letters" rather than by the specific
  // emoji, so a change of emoji in some later version still gets caught.
  function stripNttTitle() {
    const h = document.querySelector('.name-that-tune-module__title');
    if (!h) return;
    const clean = h.textContent.replace(/^[^\p{L}\p{N}]+/u, '');
    if (clean && clean !== h.textContent) h.textContent = clean;
  }

  // Two jobs, both about the same thing: Name That Tune's route chunk runs too
  // early when Spotify RESTORES that route at launch, and it assumes Spicetify
  // is already finished booting.
  //
  //  1. The case add-only cannot reach: booting onto the route with the game
  //     already showing an answer. Nothing has rendered at that point, so the
  //     absent reveal panel reads as "a round is up" and hides the play bar for
  //     a reveal that is not hidden anyway. Assuming a round IS the right
  //     default -- guessing wrong the other way puts the answer on screen -- so
  //     it is corrected once, when the app is actually up.
  //
  //  2. If the app never comes up at all, bounce the route so it mounts again.
  //     The Locale stand-in above fixes one of these races; it is not the only
  //     one. `class Gn { state = { location: Spicetify.Platform.History.location } }`
  //     throws the same way when the route mounts before Platform.History
  //     exists, which measured at ~1000ms into boot. Rather than stand in for
  //     the router as well -- a stub location that never corrects itself would
  //     be worse than the crash -- this waits for the app to render and, if it
  //     does not, navigates away and back so React builds the component again
  //     against a Spicetify that has finished starting.
  //
  //     Detected by the app's own container failing to appear, not by the error
  //     boundary's text, which is translated. Bounded to two attempts: if
  //     something is broken for good, an extension that navigates in a loop is
  //     a far worse problem than a page that says so.
  let nttBounces = 0;
  (function settleNameThatTune(tries) {
    if (!onNttRoute()) return;
    if (!document.querySelector('.name-that-tune-module__container')) {
      if (tries > 0) return setTimeout(() => settleNameThatTune(tries - 1), 150);
      if (nttBounces++ >= 2) return;
      const H = Spicetify.Platform?.History;
      if (!H) return;
      console.warn('[liquify-ui-tweaks] name-that-tune did not render; remounting it');
      H.replace('/');
      setTimeout(() => {
        H.push({ pathname: '/name-that-tune', search: `?t=${Date.now()}` });
        setTimeout(() => settleNameThatTune(60), 400);
      }, 350);
      return;
    }
    if (nttRevealed()) document.body.classList.remove('name-that-tune--guessing');
  })(60);

  // ---- settings that no longer do anything -----------------------------------
  //
  // This fork has grown its own controls, and several of the theme's now either
  // duplicate them or drive machinery that has been switched off underneath
  // them. A setting that does nothing is worse than a missing one: it invites
  // you to change it, and then to wonder what is broken when nothing moves.
  //
  // Hidden, not deleted. Every one of these keys is still read by the theme,
  // and some are written by the code that replaced them -- the fabric
  // background sets the background MODE to keep Liquify's accent sampling
  // alive, for instance. Removing the row removes the invitation, not the
  // setting.
  const DEAD_ROWS = [
    // Both of these blur .liquify-bg-layer, which liquify-fabric-bg reduces to
    // a 1px transparent element -- the layer is kept only so Liquify can still
    // sample it for --liquify-accent. The visible background is a canvas, and
    // its own Blur and Distortion live in the Background tab above.
    'Background Blur (px)',
    'Background Brightness (%)',
    // Chooses between background modes that the canvas covers completely.
    'Background:',
    // Feeds the resolution of those same hidden layers.
    'Use hi-res pictures',
    // Superseded by the font fields in the Background tab, which take ANY font
    // installed on this machine rather than the theme's built-in list. Same two
    // localStorage keys, so this is two controls for one setting.
    'Body Font',
    'Heading Font',
    // The glass on these two panels is drawn by the shader pass now. Switching
    // these on would stack a full-viewport backdrop-filter on top of it: double
    // the blur, and the entire cost the shader pass exists to avoid.
    'Blur Behind Left Sidebar',
    'Blur Behind Right Sidebar',
  ];

  // The settings panel ships fully transparent, which was survivable when it
  // opened over a flat background and is not now: it opens over a track list,
  // and two sets of text at the same size in the same pixels reads as noise.
  //
  // Set on the ELEMENT rather than in a stylesheet. A rule with an id in the
  // selector and !important on the declaration still computed to none, while
  // the background from the very same rule applied -- the theme's own
  // `.liquifySettingsPanel { backdrop-filter: var(--glass-filter) ... }` is in
  // play and var() substitution that fails is invalid at computed-value time,
  // which resolves the property to none no matter what else the cascade says.
  // An inline style was verified to take, so that is what this uses.
  //
  // And it is a real backdrop-filter rather than the shader pass, necessarily:
  // the panel floats over DOM, and the shader draws behind all of it.
  function glazeSettingsPanel(panel) {
    if (panel.dataset.lqxGlazed) return;
    panel.dataset.lqxGlazed = '1';
    // Opacity, not a backdrop-filter, and not for want of trying. On this
    // element the property refuses to take from a stylesheet (id selector,
    // !important) AND from CSSOM in this code path, while the background from
    // the very same call applies and a backdrop-filter typed into the console a
    // second later applies too. Something in the theme's own React styling of
    // this panel is winning in a way I could not pin down.
    //
    // The goal was legibility, and an opaque panel delivers that outright: at
    // 93% there is nothing to read through. A blurred backdrop would be nicer
    // and is not worth more time than this already took.
    panel.style.setProperty('background',
      'color-mix(in srgb, var(--spice-main) 93%, transparent)', 'important');
    panel.style.setProperty('border-radius', '18px', 'important');
  }

  function pruneSettings() {
    const panel = document.querySelector(LQ_PANEL);
    if (!panel) return;
    glazeSettingsPanel(panel);
    if (panel.dataset.lqxPruned === String(DEAD_ROWS.length)) return;

    let hid = 0;
    for (const label of panel.querySelectorAll('.liquifyLabel')) {
      const text = label.textContent.trim();
      if (!DEAD_ROWS.some((d) => text.startsWith(d))) continue;
      const row = label.closest('.liquifyRow');
      // `hidden` for intent, and a stylesheet to actually do it. The `hidden`
      // attribute hides nothing here: the UA rule behind it is [hidden]{display:
      // none} at UA precedence, and the theme's own `.liquifyRow{display:flex}`
      // is an author rule, so it wins every time. These eight rows were set
      // hidden two revisions ago and stayed on screen at their full 50px, which
      // is why the theme still appeared to have two sets of background
      // controls. Nothing caught it because the check read `row.hidden` -- the
      // property that had just been assigned -- instead of the computed
      // display. See the rule in lqx-settings-merge-style.
      if (row && !row.hidden) { row.hidden = true; hid++; }
    }
    if (!hid) return;

    // A heading over nothing is its own kind of confusing, so a sub-section
    // emptied by the above goes with its rows.
    //
    // "Emptied by the above" is doing real work in that sentence: the test has
    // to be that a container HAD rows and has none left, not that it has none.
    // Checking only the latter hid the Config section, whose Copy, Paste and
    // Reset are buttons rather than rows -- a section that was never made of
    // rows is not an emptied section, it is a different kind of section.
    const emptied = (el) => {
      const rows = el.querySelectorAll('.liquifyRow');
      return rows.length > 0 && ![...rows].some((r) => !r.hidden);
    };
    for (const sub of panel.querySelectorAll('.liquifySubSection')) {
      if (emptied(sub)) sub.hidden = true;
    }
    // Whole SECTIONS are left alone even when emptied. Each one is the target
    // of a button in the tab strip, and a tab that scrolls to a hidden element
    // is a tab that does nothing when clicked. The heading stays as the anchor;
    // the rows under it are gone, which is what was asked for.
    panel.dataset.lqxPruned = String(DEAD_ROWS.length);
  }

  new MutationObserver(() => { decorate(); repairNameThatTune(); pruneSettings(); })
    .observe(document.body, { childList: true, subtree: true });
  decorate();
  repairNameThatTune();
  pruneSettings();

  const settingsStyle = document.createElement('style');
  settingsStyle.id = 'lqx-settings-merge-style';
  settingsStyle.textContent = `
    /* What makes pruneSettings' \`hidden\` mean anything. The theme sets
       display on .liquifyRow and .liquifySubSection, which outranks the UA
       [hidden] rule, so this has to restate it as an author rule. */
    .liquifyRow[hidden], .liquifySubSection[hidden], .liquifySection[hidden]{display:none!important}
    .lqx-settings-tabs{display:flex;gap:6px;padding:4px 4px 10px;justify-content:center}
    .lqx-settings-tab{appearance:none;border:0;cursor:pointer;padding:5px 16px;border-radius:999px;
      font:600 12px -apple-system,system-ui,sans-serif;color:rgba(255,255,255,.7);
      background:rgba(255,255,255,.08);transition:background .16s ease,color .16s ease}
    .lqx-settings-tab:hover{background:rgba(255,255,255,.14);color:#fff}
    .lqx-settings-tab.active{background:rgba(255,255,255,.22);color:#fff}
    /* Liquify's overlay is positioned for its own gear; centre it like the
       lyrics panel so the two tabs land in the same place on screen */
    ${LQ_OVERLAY} ${LQ_PANEL}{margin:0 auto}

    /* (the settings panel's own backdrop is set on the element -- see
       glazeSettingsPanel below, and the note there for why) */`;
  document.head.appendChild(settingsStyle);

  window.liquifyUiTweaks = { sweep, HIDE_CHIPS };
})();
