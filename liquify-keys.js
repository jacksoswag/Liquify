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

  const sidebarStyle = document.createElement('style');
  sidebarStyle.textContent =
    `html.lqx-no-left .Root__nav-bar{display:none!important}` +
    `html.lqx-no-right .Root__right-sidebar{display:none!important}`;
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
    ['',          'ArrowLeft',  'Back 5 seconds',             () => seek(-5000)],
    ['',          'ArrowRight', 'Forward 5 seconds',          () => seek(5000)],

    // --- app (alt) ---
    ['cmd+alt',   'ArrowLeft',  'Back out of library folder', libraryBack],
    ['alt',       'ArrowLeft',  'Navigate back',              navBack],
    ['alt',       'ArrowRight', 'Navigate forward',           () => P.History.goForward()],
    ['alt',       'KeyH',       'Home',                       () => nav('/')],
    ['alt',       'KeyS',       'Reveal bar + search',        toggleSearch],
    ['alt',       'KeyQ',       'Queue',                      () => clickByLabel('Queue')],
    ['alt',       'KeyM',       'Marketplace',                () => nav('/marketplace')],
    ['alt',       'KeyP',       'Your profile',               () => nav('/user/' + P.username)],
    ['alt',       'KeyL',       'Toggle lyrics',              toggleLyrics],
    ['alt',       'KeyB',       'Toggle left sidebar',        toggleLeftSidebar],
    ['alt+shift', 'KeyB',       'Toggle right sidebar',       toggleRightSidebar],
    ['alt',       'KeyE',       'Expand / collapse library',  () =>
                                  clickByLabel('Collapse Your Library', 'Expand Your Library')],
    ['alt',       'KeyF',       'Friend activity',            () => clickByLabel('Listening activity')],
    ['alt+shift', 'KeyF',       'Search in library',          () => clickByLabel('Search in Your Library')],
    ['alt',       'KeyD',       'Connect to a device',        () => clickByLabel('Connect to a device')],
    ['alt',       'Comma',      'Settings',                   openSettings],
    ['alt+shift', 'KeyP',       'Performance mode',           togglePerf],
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
    if (!mod && isTyping(document.activeElement)) return;
    if (mod && isTyping(document.activeElement) && mod !== 'cmd' && mod !== 'alt') return;
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
