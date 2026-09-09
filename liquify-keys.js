// liquify-keys — keyboard-driven control for Spotify.
//
// Convention (the user's): CMD = acts on the current song, ALT = acts on the app.
//
// Two details that are easy to get wrong on macOS and are load-bearing here:
//
//   1. Alt+letter does not produce that letter. macOS composes dead keys, so
//      Alt+S arrives as `e.key === "ß"`, Alt+L as "¬", and so on. Every binding
//      is therefore matched on `e.code` ("KeyS"), which is layout- and
//      modifier-independent. Matching on `e.key` silently breaks every Alt bind.
//
//   2. Some combos are claimed by the native macOS menu bar before the web
//      layer ever sees them -- Cmd+M (Window > Minimize) is the notable one, so
//      mute is on Cmd+Shift+M instead. Cmd+R would reload the client, which is
//      why it is preventDefault-ed rather than merely handled.
//
// Runs alongside Spicetify's own keyboardShortcut.js, which already owns
// j/k, g g, Shift+G, Shift+H/L, m, /, f, Ctrl+arrows and Ctrl+Q. Nothing here
// collides with those.

(function liquifyKeys() {
  if (!window.Spicetify?.Player || !Spicetify.Platform?.History || !document.body) {
    return setTimeout(liquifyKeys, 300);
  }

  const P = Spicetify.Platform;
  const nav = (path) => P.History.push(path);
  const clickByLabel = (...labels) => {
    for (const l of labels) {
      const all = [...document.querySelectorAll('button')]
        .filter((x) => x.getAttribute('aria-label') === l);
      // Prefer a visible match, but fall back to a hidden one: the library and
      // Now Playing toggles are deliberately hidden by the Hide Library Chrome
      // snippet and driven only from here, and a zero-width element still
      // dispatches a click perfectly well.
      const b = all.find((x) => x.getBoundingClientRect().width > 0) || all[0];
      if (b) { b.click(); return true; }
    }
    return false;
  };

  // ---- sidebars: hide the column entirely, not just collapse it ----
  //
  // Spotify's own controls only collapse: the left sidebar leaves an icon rail
  // and the right one leaves a 32px strip (measured). With their toggle buttons
  // hidden by the Hide Library Chrome snippet that strip is dead space, so both
  // are removed from the grid outright.
  //
  // .Root__top-container is a grid whose columns are explicit pixels, so hiding
  // the element alone would leave its track behind. Both flags are applied by
  // one function that re-reads the natural widths with any override cleared --
  // otherwise toggling one sidebar bakes in the other's collapsed width.
  let leftHidden = false, rightHidden = false;
  function syncSidebars() {
    const cont = document.querySelector('.Root__top-container');
    if (!cont) return;
    document.documentElement.classList.toggle('lqx-no-left', leftHidden);
    document.documentElement.classList.toggle('lqx-no-right', rightHidden);
    cont.style.removeProperty('grid-template-columns');
    if (!leftHidden && !rightHidden) return;
    const cols = getComputedStyle(cont).gridTemplateColumns.split(' ');
    const left = leftHidden ? '0px' : (cols[0] || 'auto');
    const right = rightHidden ? '0px' : (cols[2] || 'auto');
    cont.style.setProperty('grid-template-columns', `${left} 1fr ${right}`, 'important');
  }
  const toggleLeftSidebar = () => { leftHidden = !leftHidden; syncSidebars(); };
  const toggleRightSidebar = () => { rightHidden = !rightHidden; syncSidebars(); };

  // The player bar needs no grid bookkeeping the way the sidebars do: with the
  // theme's floating player it is position:absolute and its grid row already
  // measures 0px, so moving it moves nothing else. Both selectors are covered
  // because the theme swaps between the two wrappers depending on whether the
  // floating player is on. Unlike the sidebars this one slides out of the
  // bottom of the window rather than being cut -- see the style below.
  let barHidden = false;
  const togglePlayBar = () => {
    barHidden = !barHidden;
    document.documentElement.classList.toggle('lqx-no-playbar', barHidden);
  };

  const sidebarStyle = document.createElement('style');
  sidebarStyle.textContent =
    `html.lqx-no-left .Root__nav-bar{display:none!important}` +
    `html.lqx-no-right .Root__right-sidebar{display:none!important}` +
    // The player bar slides down out of the window instead of being cut. Three
    // things this has to get right:
    //
    //  - The transition lives on the bar unconditionally, not inside the
    //    .lqx-no-playbar rule, or only the hide would animate and the return
    //    would snap. It also has to outrank `transition: width .5s ease`, which
    //    the floating player sets on .Root__now-playing-bar and which replaced
    //    the whole shorthand -- measured: transition-property resolved to
    //    "width" on the bar while the inner aside got the intended list. Hence
    //    `html body` in front, and `width .5s ease` carried along at its
    //    original timing so the player's width animation still works.
    //  - `transform: none !important` is set on both these selectors by the
    //    Dynamic Search Bar snippet. Adding `html.lqx-no-playbar` in front wins
    //    on specificity (0,2,1 against 0,1,0) with both marked important, so the
    //    slide survives that rule rather than silently doing nothing.
    //  - 100% is the bar's own height, which clears the window exactly; the
    //    extra 24px carries the floating player's shadow and rim out with it.
    //
    // visibility is what actually takes it out of painting and hit-testing once
    // it has gone, delayed by the length of the slide so the animation is still
    // visible on the way out, and switched with no delay on the way back in.
    `html body .Root__now-playing-bar,html body aside[aria-label="Now playing bar"]{` +
      `transition:transform .34s cubic-bezier(.32,.72,0,1),opacity .26s ease,` +
      `visibility 0s,width .5s ease}` +
    `html.lqx-no-playbar .Root__now-playing-bar,` +
    `html.lqx-no-playbar aside[aria-label="Now playing bar"]{` +
      `transform:translateY(calc(100% + 24px))!important;opacity:0!important;` +
      `visibility:hidden!important;pointer-events:none!important;` +
      `transition:transform .34s cubic-bezier(.32,.72,0,1),opacity .26s ease,visibility 0s linear .34s}`;
  document.head.appendChild(sidebarStyle);

  // ---- shuffle: cycle rather than toggle ----
  const cycleShuffle = () => {
    const smart = P.ContextualShuffleAPI;
    const on = Spicetify.Player.getShuffle();
    if (smart && typeof smart.setContextualShuffle === 'function') {
      // off -> shuffle -> smart shuffle -> off
      const isSmart = !!smart.getContextualShuffle?.();
      if (!on && !isSmart) { Spicetify.Player.setShuffle(true); }
      else if (on && !isSmart) { smart.setContextualShuffle(true); }
      else { smart.setContextualShuffle(false); Spicetify.Player.setShuffle(false); }
    } else {
      Spicetify.Player.setShuffle(!on);
    }
  };

  const seek = (deltaMs) => {
    const t = Spicetify.Player.getProgress() + deltaMs;
    Spicetify.Player.seek(Math.max(0, Math.min(Spicetify.Player.getDuration() - 250, t)));
  };

  const toast = (msg) => Spicetify.showNotification?.(msg);

  // ---- add current track to a playlist (Cmd+P) ----
  //
  // Spotify's own "Add to playlist" lives in a context menu that cannot be
  // opened programmatically in any stable way, so this is a small picker of its
  // own: type to filter, Enter to add.
  async function addToPlaylist() {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri) return toast('No track playing');
    let items = [];
    try {
      const res = await P.LibraryAPI.getContents({ filters: ['Playlists'], limit: 300 });
      items = (res.items || []).filter((i) => i.type === 'playlist' && i.canAdd !== false);
    } catch (e) { return toast('Could not load playlists'); }
    if (!items.length) return toast('No editable playlists');
    picker(items.map((i) => ({ label: i.name, value: i.uri })), async (choice) => {
      try {
        await P.PlaylistAPI.add(choice.value, [uri], { before: 'end' });
        toast('Added to ' + choice.label);
      } catch (e) { toast('Could not add: ' + e.message); }
    });
  }

  // ---- generic filterable picker overlay ----
  let openPicker = null;
  function picker(rows, onPick) {
    closeOverlays();
    const wrap = document.createElement('div');
    wrap.className = 'lqx-keys-overlay';
    wrap.innerHTML =
      `<div class="lqx-keys-panel"><input class="lqx-keys-input" placeholder="Filter…" />` +
      `<div class="lqx-keys-list"></div></div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('.lqx-keys-input');
    const list = wrap.querySelector('.lqx-keys-list');
    let view = rows, sel = 0;
    const render = () => {
      list.innerHTML = view.slice(0, 60)
        .map((r, i) => `<div class="lqx-keys-row${i === sel ? ' sel' : ''}">${
          r.label.replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]))}</div>`).join('');
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    render();
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      view = rows.filter((r) => r.label.toLowerCase().includes(q));
      sel = 0; render();
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, view.length - 1); render(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') { const c = view[sel]; closeOverlays(); if (c) onPick(c); }
      else if (e.key === 'Escape') { closeOverlays(); return; }
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeOverlays(); });
    openPicker = wrap;
    input.focus();
  }

  function closeOverlays() {
    document.querySelectorAll('.lqx-keys-overlay').forEach((n) => n.remove());
    openPicker = null;
  }

  // ---- the binding table ----
  //
  // Each entry: [modifier set, e.code, description, action]. `mod` is 'cmd',
  // 'alt', 'cmd+shift', 'alt+shift' or '' (no modifier).
  const BINDS = [
    // --- song (cmd) ---
    ['cmd',       'KeyL',       'Like / unlike track',        () => Spicetify.Player.toggleHeart()],
    ['cmd',       'KeyS',       'Cycle shuffle',              cycleShuffle],
    ['cmd',       'KeyR',       'Cycle repeat',               () => Spicetify.Player.toggleRepeat()],
    ['cmd',       'KeyP',       'Add track to playlist…',     addToPlaylist],
    ['cmd+shift', 'KeyM',       'Mute / unmute',              () => Spicetify.Player.toggleMute()],
    ['cmd+shift', 'KeyC',       'Copy track link',            copyTrackLink],
    ['cmd',       'KeyB',       'Toggle header bar',          toggleHeaderBar],
    ['cmd+shift', 'KeyB',       'Toggle play bar',            togglePlayBar],
    ['',          'ArrowLeft',  'Back 5 seconds',             () => seek(-5000)],
    ['',          'ArrowRight', 'Forward 5 seconds',          () => seek(5000)],

    // --- app (alt) ---
    // Alt+Shift, not Cmd+Alt. Cmd+Alt+Left never reached this handler however it
    // was bound, so the Cmd+Alt alias that used to sit here was dead weight and
    // a misleading row in the cheat sheet. Alt+Shift also matches the
    // convention the rest of the list follows -- Alt for app actions, next to
    // Alt+Shift+B and Alt+Shift+F.
    ['alt+shift', 'ArrowLeft',  'Back out of library folder', libraryBack],
    ['alt',       'ArrowLeft',  'Navigate back',              navBack],
    ['alt',       'ArrowRight', 'Navigate forward',           () => P.History.goForward()],
    ['alt',       'KeyH',       'Home',                       () => nav('/')],
    ['alt',       'KeyS',       'Reveal bar + search',        toggleSearch],
    ['alt',       'KeyQ',       'Queue',                      () => clickByLabel('Queue')],
    ['alt',       'KeyN',       'Now Playing view',           toggleNowPlaying],
    ['alt',       'KeyM',       'Marketplace',                () => nav('/marketplace')],
    ['alt',       'KeyP',       'Your profile',               () => nav('/user/' + P.username)],
    ['alt',       'KeyL',       'Toggle lyrics',              toggleLyrics],
    ['alt',       'KeyB',       'Toggle left sidebar',        toggleLeftSidebar],
    ['alt+shift', 'KeyB',       'Toggle right sidebar',       toggleRightSidebar],
    ['alt',       'KeyF',       'Friend activity',            () => clickByLabel('Listening activity')],
    ['alt+shift', 'KeyF',       'Search in library',          () => clickByLabel('Search in Your Library')],
    ['alt',       'KeyD',       'Connect to a device',        () => clickByLabel('Connect to a device')],
    ['alt',       'Comma',      'Settings',                   openSettings],
    ['alt+shift', 'KeyP',       'Performance mode',           togglePerf],
    ['alt+shift', 'KeyD',       'Pointer probe (debug)',      togglePointerProbe],
    ['alt',       'Slash',      'Show this shortcut list',    showCheatSheet],
  ];

  // Clicking a folder ROW drills into it and puts a "Go back" button in the
  // sidebar header; clicking its chevron instead expands it inline, with no
  // navigation. This handles both, drill-in first.
  //
  // The nav-bar scope is load-bearing: the top bar has its own button with the
  // identical aria-label "Go back" for browser-style history, so an unscoped
  // lookup would walk the app's history instead of leaving the folder.
  function libraryBack() {
    const nav = document.querySelector('.Root__nav-bar');
    if (!nav) return;
    const inFolder = [...nav.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Go back');
    if (inFolder) { inFolder.click(); return; }
    const expanded = [...nav.querySelectorAll('button')]
      .filter((b) => b.getAttribute('aria-label') === 'Collapse folder');
    if (expanded.length) expanded[expanded.length - 1].click();   // innermost first
  }

  // ---- right panel: the friend feed is the default ----
  //
  // Spotify switches the right sidebar to the Now Playing view whenever
  // playback starts, which loses the friend feed on every track change. There
  // is no PanelAPI on this build (Spicetify.Panel and Platform.PanelAPI are
  // both absent), so the panel is identified by the aria-label its <aside>
  // carries and driven by the same buttons the UI uses -- both of which the
  // Hide Library Chrome / Hide Home Chrome snippets hide, which is fine:
  // clickByLabel deliberately falls back to hidden elements.
  //
  // The switch back only happens when the Now Playing view appears WITHOUT
  // having been asked for. Alt+N sets that intent, so a panel the user opened
  // stays open across track changes; anything else that opens it is undone.
  const FRIENDS = 'Listening activity';
  const NPV = 'Now playing view';
  const rightPanel = () =>
    document.querySelector('.Root__right-sidebar aside')?.getAttribute('aria-label') || '';
  let npvWanted = false;

  const showFriends = () => { if (rightPanel() !== FRIENDS) clickByLabel(FRIENDS); };
  function toggleNowPlaying() {
    if (rightPanel() === NPV) { npvWanted = false; showFriends(); return; }
    npvWanted = true;
    clickByLabel('Show Now Playing view', 'Hide Now Playing view');
  }

  // Driven by track changes, not by DOM mutations. A MutationObserver here
  // wedged the renderer outright: its callback runs as a microtask, clicking
  // from inside it mutates the DOM, and that queues the callback again before
  // the event loop regains control -- the app stopped responding entirely, with
  // even 1+1 failing to evaluate over the debugging protocol. Rate-limiting it
  // was not enough, so the observer is gone.
  //
  // songchange is the only thing that actually causes the unwanted switch, so
  // that is what this listens to. The delay lets Spotify finish opening the
  // panel before it is put back; doing it synchronously raced the switch and
  // sometimes lost.
  function restoreFriends() {
    if (npvWanted) return;
    setTimeout(() => { if (!npvWanted && rightPanel() === NPV) showFriends(); }, 350);
  }
  Spicetify.Player.addEventListener('songchange', restoreFriends);

  // Making it the default needs retries, not one shot. A single attempt at
  // startup lost the race whenever the sidebar or the top-bar button had not
  // mounted yet -- clickByLabel simply found nothing and returned false, and the
  // app opened on Now Playing with no second try. This keeps asking until the
  // panel actually reports the friend feed, then stops, and gives up after
  // ~20s so a build without a friend feed does not click forever.
  (function openFriendsAtStart(tries) {
    if (npvWanted || rightPanel() === FRIENDS) return;
    showFriends();
    if (tries > 0) setTimeout(() => openFriendsAtStart(tries - 1), 600);
  })(33);

  // ---- pointer probe (Alt+Shift+D) ----
  //
  // For the class of bug where a control's visual and its clickable area
  // disagree. Everything inside the renderer can be verified from here --
  // getBoundingClientRect, elementFromPoint, injected mouse events and a
  // screenshot with markers drawn at the measured rects all agreed for the
  // library header buttons -- which leaves only the mapping between the real
  // cursor and the page's coordinate space, and that is not observable without
  // a physical pointer. This draws where the PAGE thinks the pointer is: if the
  // crosshair does not sit under the actual cursor, the offset between them is
  // the bug, and its size and direction are readable straight off the screen.
  let probeOn = false, probeEls = null;
  function togglePointerProbe() {
    probeOn = !probeOn;
    if (!probeOn) {
      probeEls?.cross.remove(); probeEls?.readout.remove(); probeEls?.box.remove();
      document.removeEventListener('mousemove', probeEls.onMove, true);
      probeEls = null;
      return;
    }
    const mk = (css) => { const d = document.createElement('div'); d.style.cssText = css; document.body.appendChild(d); return d; };
    const base = 'position:fixed;pointer-events:none;z-index:2147483647';
    const cross = mk(base + ';width:31px;height:31px;margin:-15px 0 0 -15px;' +
      'background:linear-gradient(magenta,magenta) center/100% 1px no-repeat,' +
      'linear-gradient(magenta,magenta) center/1px 100% no-repeat');
    const box = mk(base + ';outline:2px solid cyan');
    const readout = mk(base + ';left:12px;bottom:12px;padding:6px 9px;border-radius:8px;' +
      'background:#000c;color:#fff;font:600 12px/1.5 ui-monospace,monospace;white-space:pre');
    const onMove = (e) => {
      cross.style.left = e.clientX + 'px';
      cross.style.top = e.clientY + 'px';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const btn = el?.closest?.('button, a, [role="button"]');
      const t = btn || el;
      if (t) {
        const r = t.getBoundingClientRect();
        box.style.cssText = base + `;outline:2px solid cyan;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
      }
      // screenX/screenY are the OS pointer position, clientX/clientY the page's.
      // Subtracting the window's own screen origin converts one into the
      // other's space, so `delta` is exactly the mismatch being hunted: zero
      // means the page and the cursor agree, a constant non-zero value means
      // the window's content origin is misplaced, and a value that grows as the
      // pointer moves right and down means the frame is being scaled -- the
      // renderer's viewport and the window's content area disagree on size.
      const dx = (e.screenX - window.screenX) - e.clientX;
      const dy = (e.screenY - window.screenY) - e.clientY;
      const r = t ? t.getBoundingClientRect() : null;
      readout.textContent =
        `page     ${Math.round(e.clientX)}, ${Math.round(e.clientY)}\n` +
        `screen   ${Math.round(e.screenX)}, ${Math.round(e.screenY)}\n` +
        `window   ${Math.round(window.screenX)}, ${Math.round(window.screenY)}\n` +
        `delta    ${Math.round(dx)}, ${Math.round(dy)}\n` +
        `viewport ${innerWidth}x${innerHeight}  outer ${outerWidth}x${outerHeight}\n` +
        `dpr      ${devicePixelRatio}\n` +
        `element  ${t ? (t.getAttribute?.('aria-label') || t.tagName) : 'none'}\n` +
        (r ? `box      ${Math.round(r.x)}, ${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : '');
    };
    document.addEventListener('mousemove', onMove, true);
    probeEls = { cross, box, readout, onMove };
  }

  // ---- header bar ----
  //
  // The Dynamic Search Bar snippet collapses #global-nav-bar to an 8px hover
  // catcher and reopens it on hover or when an input inside it takes focus.
  // These two just drive that same state deliberately.
  //
  // Note Alt+S does NOT navigate to /search: that opens Spotify's browse page
  // full of genre cards, which is not what "search" means here. Focusing the
  // field is enough -- typing in it searches from wherever you already are.
  let navPinned = false, navTemp = false;
  const searchInput = () => document.querySelector('#global-nav-bar input[type="search"]');
  const syncNav = () =>
    document.documentElement.classList.toggle('lqx-nav-open', navPinned || navTemp);

  function toggleHeaderBar() { navPinned = !navPinned; navTemp = false; syncNav(); }

  function toggleSearch() {
    const input = searchInput();
    if (input && document.activeElement === input) {   // already searching: put it away
      input.blur(); navTemp = false; navPinned = false; syncNav(); return;
    }
    navTemp = true; syncNav();
    if (!input) return;
    // let the bar finish expanding so focus lands on a laid-out element
    requestAnimationFrame(() => {
      input.focus();
      input.select?.();
      const release = () => {
        input.removeEventListener('blur', release);
        navTemp = false; syncNav();
      };
      input.addEventListener('blur', release);
    });
  }

  // Alt+Left walks the history back, and when the chain runs out it lands on
  // Home rather than doing nothing -- so holding it down always ends somewhere
  // known. `replace` rather than `push`: Home has to be the TERMINUS, and a
  // push would add an entry that the next Alt+Left would immediately walk back
  // off again.
  function navBack() {
    const h = P.History;
    const canBack = typeof h.canGo === 'function' ? h.canGo(-1) : h.index > 0;
    if (canBack) { h.goBack(); return; }
    if (h.location?.pathname !== '/') h.replace('/');
  }

  function copyTrackLink() {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri) return toast('No track playing');
    const url = 'https://open.spotify.com/track/' + uri.split(':').pop();
    (P.ClipboardAPI?.copy ? P.ClipboardAPI.copy(url) : navigator.clipboard.writeText(url));
    toast('Track link copied');
  }

  function toggleLyrics() {
    document.getElementById('liquid-lyrics-button')?.click()
      || clickByLabel('Lyrics');
  }

  function openSettings() {
    // the merged panel lives on Liquid Lyrics' settings button; fall back to
    // Liquify's own gear if Liquid Lyrics is not mounted
    const merged = document.querySelector('.ll-settings-btn');
    if (merged) return merged.click();
    document.getElementById('liquify-settings-gear-btn')?.click();
  }

  function togglePerf() {
    // liquify-perf owns the actual mode; this just flips its stored flag and
    // lets it re-read, so the two never disagree
    window.dispatchEvent(new CustomEvent('lqx-toggle-perf'));
  }

  function showCheatSheet() {
    if (document.querySelector('.lqx-keys-overlay')) return closeOverlays();
    const pretty = (mod, code) => {
      const k = code.replace(/^Key/, '').replace('Comma', ',').replace('Slash', '/')
        .replace('ArrowLeft', '←').replace('ArrowRight', '→');
      const m = mod.replace('cmd', '⌘').replace('alt', '⌥').replace('shift', '⇧').replace(/\+/g, '');
      return m + k;
    };
    const rows = BINDS.map(([m, c, d]) =>
      `<div class="lqx-keys-cheat-row"><kbd>${pretty(m, c)}</kbd><span>${d}</span></div>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'lqx-keys-overlay';
    wrap.innerHTML = `<div class="lqx-keys-panel lqx-keys-cheat">
      <div class="lqx-keys-cheat-title">Keyboard shortcuts</div>${rows}</div>`;
    wrap.addEventListener('mousedown', () => closeOverlays());
    document.body.appendChild(wrap);
  }

  // ---- dispatch ----
  const modOf = (e) => {
    const parts = [];
    if (e.metaKey) parts.push('cmd');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    return parts.join('+');
  };

  const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                                    el.isContentEditable);

  window.addEventListener('keydown', (e) => {
    if (openPicker) return;                       // picker handles its own keys
    if (e.ctrlKey) return;                        // leave Ctrl to keyboardShortcut.js
    const mod = modOf(e);
    // Bare arrows seek, but never while typing or while a list has focus and
    // the user is arrowing through it with no modifier held.
    //
    // While typing, only the chords that could plausibly be text editing are
    // held back -- no modifier, and Shift on its own. The earlier test was
    // `mod !== 'cmd' && mod !== 'alt'`, which let those two through by exact
    // string and therefore silently swallowed every combination:
    // Cmd+Alt+Left did nothing at all whenever focus sat in a text field, and
    // the search box takes focus readily. Cmd and Alt combinations are never
    // text editing on macOS, so they pass.
    if (isTyping(document.activeElement) && !/cmd|alt/.test(mod)) return;

    const hit = BINDS.find(([m, code]) => m === mod && code === e.code);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    try { hit[3](); } catch (err) { console.error('[liquify-keys]', hit[2], err); }
  }, true);

  // ---- styles for the overlays ----
  const st = document.createElement('style');
  st.id = 'lqx-keys-style';
  st.textContent = `
    .lqx-keys-overlay{position:fixed;inset:0;z-index:100000;display:flex;
      align-items:flex-start;justify-content:center;padding-top:14vh;
      background:rgba(0,0,0,.45)}
    .lqx-keys-panel{min-width:380px;max-width:560px;max-height:64vh;overflow:auto;
      padding:12px;border-radius:16px;background:rgba(28,28,30,.82);
      backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
      box-shadow:inset 0 1px 1px rgba(255,255,255,.55),
                 inset 0 -1px 1px rgba(255,255,255,.12),
                 inset 0 0 0 1px rgba(255,255,255,.06);
      color:#fff;font:13px -apple-system,system-ui,sans-serif}
    .lqx-keys-input{width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:8px;
      border:0;border-radius:10px;background:rgba(255,255,255,.09);color:#fff;outline:none}
    .lqx-keys-row{padding:7px 10px;border-radius:9px;cursor:pointer;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .lqx-keys-row.sel{background:rgba(255,255,255,.16)}
    .lqx-keys-cheat-title{font-weight:700;font-size:14px;padding:2px 8px 10px}
    .lqx-keys-cheat-row{display:flex;gap:12px;align-items:center;padding:4px 8px}
    .lqx-keys-cheat-row kbd{flex:0 0 84px;text-align:center;padding:3px 6px;border-radius:7px;
      background:rgba(255,255,255,.12);font:12px ui-monospace,monospace}
    .lqx-keys-cheat-row span{opacity:.85}
    /* id + class + id outranks the snippet's own id-only height rule */
    html.lqx-nav-open #global-nav-bar{height:64px!important;opacity:1!important}`;
  document.head.appendChild(st);

  console.log('[liquify-keys] ' + BINDS.length + ' shortcuts bound (Alt+/ for the list)');
})();
