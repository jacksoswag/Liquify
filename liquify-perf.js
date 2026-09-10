// liquify-perf — GPU optimizer for the Liquify liquid-glass theme.
//
// Measured on Spotify 1.2.99 / Chromium 146, 1610x1011 @ dpr 1.83:
//   stock Liquify + Rotating Cover Art ....... 83% GPU (peaks at 100%)
//   with this extension + scoped spin ........ 16% GPU (peaks at 18%)
//   ... plus perf mode (cmd+P) ............... 14% GPU (peaks at 16%)
//
// Two changes, neither of which alters the glass look:
//
// 1. One shared filter graph instead of one per element. Stock Liquify builds a
//    `liquify-filter-N` per glass surface (86 selectors, 15 live graphs on a
//    single view). They are all the same 9-primitive chain; sharing them keeps
//    the refraction identical and lets Skia cache one graph instead of N.
//
// 2. The displacement map is rasterized to a PNG on a canvas instead of being
//    handed to feImage as an SVG data-URI. Skia rasterizes an SVG *document*
//    inside the filter graph, and stock Liquify regenerates it from a
//    ResizeObserver on every element resize. A raster blit is far cheaper.
//
// A third change does alter it, and is here because this is the file that owns
// the filter graph: the theme's glass blur is moved from a CSS `blur()` chained
// after the refraction into a primitive inside it. Chained, the blur runs on
// the refraction's already-clipped output, which is why turning that slider up
// used to cost the refraction and still not blur properly. See the block above
// rebuildGlassFilter for the measurements.
//
// There is no chromatic-aberration path any more. The filter had a second form
// that ran the displacement three times, once per colour channel, for an RGB
// fringe; it cost 32 GPU points measured, it was sub-pixel on anything smaller
// than the play bar, and every attempt to make it worth that price either
// stayed invisible or took the app to 90% GPU. One filter, one pass.

(function liquifyPerf() {
  const NS = 'http://www.w3.org/2000/svg';
  const ID = 'lqx';
  const PERF_KEY = 'liquify-perf-mode';

  if (!document.body) return setTimeout(liquifyPerf, 300);
  if (document.getElementById(ID + '-host')) return;

  const fe = (n, a) => { const el = document.createElementNS(NS, n); for (const k in a) el.setAttribute(k, a[k]); return el; };

  // Displacement map: rounded-rect R/G ramps = per-axis offset, with a blurred
  // inset plate holding the centre still so only the rim refracts.
  function rasterMap(w, h, r, edgePct, blurPx) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const rg = x.createLinearGradient(w, 0, 0, 0);
    rg.addColorStop(0, 'rgba(255,0,0,0)'); rg.addColorStop(1, 'rgba(255,0,0,1)');
    const bg = x.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(0,0,255,0)'); bg.addColorStop(1, 'rgba(0,0,255,1)');
    const rr = (X, Y, W, H, R) => { x.beginPath(); x.roundRect(X, Y, W, H, R); x.fill(); };
    x.fillStyle = rg; rr(0, 0, w, h, r);
    x.globalCompositeOperation = 'screen'; x.fillStyle = bg; rr(0, 0, w, h, r);
    x.globalCompositeOperation = 'source-over';
    const e = Math.min(w, h) * edgePct;
    x.filter = `blur(${blurPx}px)`;
    x.fillStyle = 'rgba(128,128,128,0.93)';
    rr(e, e, w - e * 2, h - e * 2, r);
    x.filter = 'none';
    return c.toDataURL('image/png');
  }

  function buildFilter(id, { scale, href, post }) {
    const f = fe('filter', { id, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
    const img = fe('feImage', { x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'map' });
    img.setAttribute('href', href);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    f.appendChild(img);
    f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: String(scale + 5), xChannelSelector: 'R', yChannelSelector: 'G', result: 'out' }));
    if (post) f.appendChild(fe('feGaussianBlur', { in: 'out', stdDeviation: String(post) }));
    return f;
  }

  const host = fe('svg', { id: ID + '-host', width: '0', height: '0', 'aria-hidden': 'true' });
  host.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none');
  const defs = document.createElementNS(NS, 'defs');
  const map = rasterMap(400, 200, 20, 0.035, 2);

  // ---- the evolving background lives in liquify-fabric-bg.js ----
  //
  // It used to be an SVG displacement filter layered over the background here.
  // That was wrong at two levels and is kept out of this file now:
  //
  //   * `feTurbulence` as the displacement map measured 80 GPU points (15% ->
  //     95%, 6 paired cycles) because procedural noise is re-synthesised per
  //     pixel per frame.
  //   * More fundamentally, post-processing the rendered layer was the wrong
  //     place to work. The layer is already downscaled, blurred and dimmed, so
  //     warping it moved the mean pixel value by 1.3% -- measured, invisible.
  //
  // The album art is now deformed at the source by a fragment shader, in
  // liquify-fabric-bg.js. The drift strength/speed keys below are still written
  // by the sliders in Liquify's settings panel and are read by that extension.

  // ---- drift settings (persisted; also exposed in Liquify's settings panel) ----
  const DRIFT_STRENGTH_KEY = 'liquify-drift-strength';   // 0-100, 0 = off
  const DRIFT_SPEED_KEY    = 'liquify-drift-speed';      // 1-100, higher = faster
  const readNum = (k, dflt) => { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : dflt; };
  const driftCfg = () => ({
    strength: Math.max(0, Math.min(100, readNum(DRIFT_STRENGTH_KEY, 35))),
    speed:    Math.max(1, Math.min(100, readNum(DRIFT_SPEED_KEY, 65))),
  });

  // ---- glass blur: inside the filter, not chained after it ----
  //
  // The theme emits, for every glass surface,
  //
  //   backdrop-filter: var(--glass-filter) blur(var(--liquify-glass-blur, 2px))
  //
  // and a CSS filter list runs left to right, so that blurs the REFRACTION
  // rather than the backdrop. Measured on the play bar against a track list:
  //
  //   blur 0px ..... refraction, no blur          (what the fork shipped)
  //   blur 2px ..... refraction, a faint blur     (the theme's default)
  //   blur 18px .... no refraction, and a blur visibly weaker than a plain
  //                  `backdrop-filter: blur(18px)` on the same element, with
  //                  legible text still coming through at the top and bottom
  //
  // Both of those are the same cause. The reference filter's region is its
  // element's own box, so its output is clipped there before the CSS blur
  // runs; the blur then has nothing to sample past the edge and falls off,
  // and whatever displacement survived is smeared into the average. Turning
  // the slider up therefore does not add blur so much as it trades the glass
  // for a bad approximation of one.
  //
  // So the blur is built into the shared filter graph instead -- as the
  // trailing feGaussianBlur `buildFilter` already takes -- and the region is
  // widened to give it room to reach past the element. Verified: widening the
  // region on its own leaves the refraction pixel-identical, so this costs the
  // blur and nothing else, on the same single backdrop surface as before.
  // CSS `blur()` equivalence is stdDeviation = radius / 2.
  const BLUR_KEY = 'liquify-glass-blur';                 // px, written by the theme's slider
  const glassBlurPx = () => Math.max(0, Math.min(64, readNum(BLUR_KEY, 2)));

  function rebuildGlassFilter() {
    const px = glassBlurPx();
    // Scoped to defs deliberately: `getElementById` would be ambiguous here,
    // since liquify-fabric-bg.js gives its glass canvas the same id.
    defs.querySelector('#' + ID + '-refract')?.remove();
    const f = buildFilter(ID + '-refract', { scale: -80, href: map, post: px / 2 });
    if (px > 0) {
      f.setAttribute('x', '-25%');     f.setAttribute('y', '-25%');
      f.setAttribute('width', '150%'); f.setAttribute('height', '150%');
    }
    defs.appendChild(f);
  }
  rebuildGlassFilter();

  host.appendChild(defs);
  document.body.appendChild(host);

  // One filter for every glass surface. There is no second tier: the SMALL list
  // that used to sit here existed only to keep the chromatic passes off
  // controls too small to show them, and there are no chromatic passes now.
  const style = document.createElement('style');
  style.id = ID + '-style';
  document.head.appendChild(style);
  function applyGlassStyle() {
    style.textContent =
      // `-refract` rather than `-glass`: liquify-fabric-bg.js gives its glass
      // canvas id `lqx-glass` too, and `url(#lqx-glass)` resolves to whichever
      // of the two is first in the document. It happens to be the filter today
      // only because this extension is listed before that one, and the failure
      // mode if that order ever changes is every glass surface in the app
      // silently losing its filter.
      // `html:root` rather than `:root`: the theme declares --liquify-glass-blur
      // with !important too, and between two !important declarations the more
      // specific selector wins whatever order the style elements landed in.
      `html:root, html [data-liquify]{--glass-filter:url(#${ID}-refract) !important;` +
      `--liquify-filter:url(#${ID}-refract) !important;` +
      // The blur lives inside that filter now (see rebuildGlassFilter), so the
      // theme's own blur term is zeroed rather than left to run a second time.
      `--liquify-glass-blur:0px !important;}` +
      // A full-viewport backdrop-filter that paints nothing.
      //
      // The theme reserves space for the window buttons with
      // .Root__top-container::after, and on macOS it sets that element's
      // opacity to 0 because the OS draws them itself. The element still
      // carries backdrop-filter:brightness(2.12) across the whole viewport, and
      // Chromium still allocates a backdrop and filters it -- 1.36 megapixels
      // of work multiplied by zero, re-run every time the background repaints
      // beneath it. That is more filtered area than every real glass surface in
      // the app put together, which is 0.10.
      //
      // Removing it changed the window by a mean of 0.056/255, maximum 2.
      // Scoped to macOS, which is exactly where the theme zeroes the opacity.
      `html.spotify__os--is-macos .Root__top-container::after{` +
      `backdrop-filter:none!important;-webkit-backdrop-filter:none!important}`;
  }
  applyGlassStyle();

  // The theme's slider writes localStorage and rewrites its own style element.
  // Neither fires anything this extension can listen for, so the value is
  // re-read on a slow poll and the graph rebuilt only when it actually moved.
  let blurWas = glassBlurPx();
  setInterval(() => {
    const now = glassBlurPx();
    if (now === blurWas) return;
    blurWas = now;
    rebuildGlassFilter();
  }, 1000);


  // ---- the theme's own background layers ----
  //
  // Gone. `.liquify-bg-layer` used to be the album art behind everything, and
  // this file spent a block shrinking its backing store so its live blur cost
  // less. Nothing draws it now: liquify-fabric-bg.js paints the background in a
  // shader and removes the theme's two cover layers, its four spinning tiles
  // and its Kawarp div from the document outright. There is nothing left to
  // style.

  // ---- shadows ----
  //
  // Two different things wear the name "shadow" in this app and they cost
  // nothing alike:
  //
  //   1. Outer drop shadows (Spotify's own, on cards/modals/overlays). Real
  //      blur radii; each is a separate rasterization of a blurred alpha mask.
  //      These are the expensive ones and they stay dropped.
  //
  //   2. Specular rims -- stacks of *inset* 1px highlights (bright top edge,
  //      bottom glow, hairline outline). These are what make a panel read as
  //      glass instead of a flat translucent box. A 1px inset shadow is painted
  //      inside the element's own display list: no separate surface, no blur
  //      pass, and unlike backdrop-filter it does not re-invalidate when the
  //      background moves.
  //
  // So the rule is structural, not a name list: preserve a box-shadow when
  // EVERY one of its layers is inset, drop it otherwise. Mixed declarations
  // (an outer glow plus an inset hairline) are dropped -- the outer layer is
  // the expensive half and it dominates those values.
  //
  // Two earlier versions got this wrong. The first killed every box-shadow
  // with one `*` rule and flattened the whole theme. The second restored a
  // list of selectors extracted from user.css at build time, which missed
  // every rim declared anywhere else: Liquid Lyrics rims its card through its
  // own `--liquid-lyrics-rim-shadow` variable in its own stylesheet, and the
  // home shortcuts container was missed too, so both panels stayed flat.
  // This version reads the live stylesheets and judges each declaration by
  // what it resolves to, so it does not care which sheet or which variable a
  // rim comes from.

  const splitLayers = (value) => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };

  // custom properties used by box-shadow values are defined on :root by both
  // Liquify and Liquid Lyrics, so resolving against documentElement is enough
  const resolveVars = (value, depth) => {
    if ((depth || 0) > 3 || value.indexOf('var(') === -1) return value;
    const root = getComputedStyle(document.documentElement);
    const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (m, name, fallback) => {
      const v = root.getPropertyValue(name);
      return v && v.trim() ? v : (fallback || '');
    });
    return resolveVars(next, (depth || 0) + 1);
  };

  const isPureInset = (value) => {
    const resolved = resolveVars(value).replace(/\/\*[\s\S]*?\*\//g, '');
    const layers = splitLayers(resolved);
    return layers.length > 0 && layers.every((l) => /(^|[\s)])inset(\s|$)/.test(' ' + l + ' '));
  };

  // declaration text -> selectors that set it. Keyed on the ORIGINAL text so the
  // re-emitted rule still points at the variable and follows any later change.
  const collectInsetShadows = () => {
    const byValue = new Map();
    const walk = (rules, parents) => {
      for (const r of rules) {
        let scope = parents;
        if (r.selectorText) {
          const groups = r.selectorText.split(',').map((s) => s.trim()).filter(Boolean);
          scope = parents.length
            ? groups.flatMap((g) =>
                parents.map((p) => (g.includes('&') ? g.split('&').join(p) : p + ' ' + g)))
            : groups;
        }
        // a nested block's own declarations surface as a rule with no selector
        const decl = r.style && r.style.getPropertyValue('box-shadow');
        if (decl && scope.length && isPureInset(decl)) {
          if (!byValue.has(decl)) byValue.set(decl, new Set());
          scope.forEach((s) => byValue.get(decl).add(s));
        }
        if (r.cssRules) walk(r.cssRules, scope);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.id === ID + '-shadows') continue;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }   // cross-origin sheet
      if (rules) walk(rules, []);
    }
    return byValue;
  };

  const shadowStyle = document.createElement('style');
  shadowStyle.id = ID + '-shadows';
  document.head.appendChild(shadowStyle);

  let lastKeep = null;
  const applyShadowStyle = () => {
    const byValue = collectInsetShadows();
    if (!byValue.size) return;
    const keep = [...byValue]
      .map(([value, sels]) => `${[...sels].join(',')} { box-shadow: ${value} !important; }`)
      .join('\n      ');
    if (keep === lastKeep) return;                  // nothing new appeared
    lastKeep = keep;
    shadowStyle.textContent = `
      *, *::before, *::after { box-shadow: none !important; text-shadow: none !important; }

      /* every all-inset shadow, restored with its own value (see note above) */
      ${keep}

      /* keep the cover-art drop shadow: one small element, and it is what gives
         the floating card its depth */
      .main-nowPlayingView-coverArt, .liquid-lyrics-song-card {
        filter: drop-shadow(0 9px 9px rgba(0,0,0,.271)) !important;
      }`;
  };
  applyShadowStyle();

  // Extensions and lazily-mounted views attach their stylesheets after boot, so
  // recollect whenever one shows up. The walk only runs when a STYLE or LINK is
  // actually added, and re-emits only when the result changed.
  {
    let timer = 0;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(applyShadowStyle, 400); };
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes)
          if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') return schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    [1000, 3000, 8000].forEach((d) => setTimeout(applyShadowStyle, d));
  }


  // ---- drift controls in Liquify's settings panel ----
  //
  // Liquify's settings UI is minified and exposes no extension point, so this
  // inserts a small section of its own at the top of the panel when it opens,
  // reusing the panel's classes so it matches. Values persist in localStorage
  // and rebuild the filter live.
  const SETTINGS_MARK = 'data-lqx-drift-ui';
  // Written here, read by liquify-fabric-bg.js on its next frame -- no rebuild
  // step, so the sliders are live.
  const FABRIC = {
    strength: { key: 'liquify-drift-strength', label: 'Distortion', min: 0, max: 100, dflt: 70 },
    speed:    { key: 'liquify-drift-speed',    label: 'Motion speed', min: 1, max: 100, dflt: 45 },
    blur:     { key: 'liquify-fabric-blur',    label: 'Blur', min: 0, max: 160, dflt: 38 },
    fps:      { key: 'liquify-fabric-fps',     label: 'Frame rate', min: 10, max: 60, dflt: 60 },
  };
  // ---- fonts ----
  //
  // Liquify's own font picker is a fixed catalogue of Google Fonts, loaded over
  // the network. But applyFonts() in the theme builds `font-family: "<value>"`
  // straight from the stored key with no validation against that catalogue, so
  // any family name written there is honoured -- including one that is only
  // installed locally. These two fields are therefore free text: whatever is in
  // ~/Library/Fonts (or anywhere else the system knows about) can be typed in
  // and will resolve.
  const FONT_KEYS = { body: 'liquify-font-body', heading: 'liquify-font-heading' };

  // Whether a family actually resolves. document.fonts.check() is no use here:
  // for an unknown family it reports the fallback as a match and returns true.
  // Measuring is unambiguous -- render the same string in the candidate with a
  // fallback behind it, and against the fallback alone. Two different fallbacks
  // are used because a font whose metrics happen to match monospace exactly
  // would otherwise read as missing.
  const fontExists = (name) => {
    const family = String(name || '').trim().replace(/["']/g, '');
    if (!family || family.toLowerCase() === 'default') return false;
    const ctx = document.createElement('canvas').getContext('2d');
    const w = (stack) => { ctx.font = `72px ${stack}`; return ctx.measureText('mmmwwwiii0123OO').width; };
    return ['monospace', 'serif'].some((base) => Math.abs(w(`"${family}", ${base}`) - w(base)) > 0.5);
  };

  // Suggestions only -- the field works whether or not this returns anything.
  // queryLocalFonts is the complete answer where it is available; it needs a
  // permission and a secure context, and simply throws where it is not.
  let localFonts = null;
  // Kicked off at load rather than when the panel opens. React rebuilds the
  // settings panel, and an async fill started on open lands on whichever copy
  // of the block existed when it was requested -- which is not necessarily the
  // one on screen, so the list came back empty. With the answer already cached
  // by the time a panel exists, the fill is synchronous and cannot miss.
  async function suggestFonts() {
    if (localFonts) return localFonts;
    try {
      if (typeof window.queryLocalFonts === 'function') {
        // Raced against a timeout, because without a user gesture this call does
        // not reject and does not resolve -- it sits waiting on a permission
        // prompt that never appears, and awaiting it bare meant the fallback
        // below never ran and the list came back empty.
        const list = await Promise.race([
          window.queryLocalFonts(),
          new Promise((r) => setTimeout(() => r([]), 400)),
        ]);
        // An empty array is not success. The API resolves with nothing when the
        // permission has not been granted -- it is gated on a user gesture, and
        // opening the panel is not one it counts -- so treat empty exactly like
        // unsupported and fall through to probing.
        const families = [...new Set(list.map((f) => f.family))].sort();
        if (families.length) { localFonts = families; return localFonts; }
      }
    } catch { /* permission refused or unsupported; fall through */ }
    // Fallback: probe a pool and keep whatever the system actually has. Misses
    // anything not named here, which is why the field is not a dropdown.
    const pool = ['Space Grotesk', 'Inconsolata', 'Crimson Text', 'Newsreader', 'Sono',
      'Monocraft', 'Latin Modern Mono', 'SF Pro', 'SF Pro Display', 'SF Pro Text', 'SF Mono',
      'Helvetica Neue', 'Avenir Next', 'Menlo', 'Monaco', 'Optima', 'Futura', 'Baskerville',
      'Georgia', 'Palatino', 'Times New Roman', 'Courier New', 'Verdana', 'Arial',
      'Charter', 'Iowan Old Style', 'Hoefler Text', 'Didot', 'American Typewriter'];
    localFonts = pool.filter(fontExists).sort();
    return localFonts;
  }

  suggestFonts();  // warm the cache before any panel exists

  function setFont(which, family) {
    const v = String(family || '').trim();
    localStorage.setItem(FONT_KEYS[which], v || 'default');
    // The theme owns the stylesheet these keys drive; this is its re-apply hook.
    try { window.liquifyApplyAllSettings?.(); } catch (e) { console.warn('[liquify-perf] font apply', e); }
  }

  const fabricVal = (k) => {
    const s = FABRIC[k], v = parseFloat(localStorage.getItem(s.key));
    return Number.isFinite(v) ? Math.max(s.min, Math.min(s.max, v)) : s.dflt;
  };

  function buildDriftUI(panel) {
    if (panel.querySelector(`[${SETTINGS_MARK}]`)) return;
    const wrap = document.createElement('div');
    wrap.setAttribute(SETTINGS_MARK, '1');
    wrap.style.cssText = 'padding:4px 4px 14px;border-bottom:1px solid rgba(255,255,255,.12);margin-bottom:14px';
    const row = (k) => {
      const s = FABRIC[k], v = fabricVal(k);
      return `
      <label style="display:flex;align-items:center;gap:10px;margin:8px 0;font:400 12px/1 inherit;opacity:.85">
        <span style="min-width:82px">${s.label}</span>
        <input type="range" min="${s.min}" max="${s.max}" step="1" value="${v}" data-lqx="${k}" style="flex:1">
        <span data-lqx-out="${k}" style="min-width:30px;text-align:right;opacity:.7">${v}</span>
      </label>`;
    };
    wrap.innerHTML = `
      <div style="font:600 13px/1.4 var(--liquify-font,inherit);opacity:.9;margin-bottom:10px">
        Background
        <div style="font:400 11px/1.4 inherit;opacity:.55;margin-top:3px">
          The album art is deformed by a continuous per-pixel warp, like a sheet
          of fabric hauled from shifting points along its edges. Distortion 0
          turns it off and restores the plain background. Frame rate is the cost
          dial: a moving backdrop forces every glass panel above it to
          recomposite, so halving it roughly halves what this costs.
        </div>
      </div>
      ${row('strength')}${row('speed')}${row('blur')}${row('fps')}`;
    const fonts = document.createElement('div');
    fonts.style.cssText = 'margin-top:14px';
    const fontRow = (which, label) => {
      const v = localStorage.getItem(FONT_KEYS[which]) || '';
      const cur = v && v !== 'default' ? v : '';
      return `
      <label style="display:flex;align-items:center;gap:10px;margin:8px 0;font:400 12px/1 inherit;opacity:.85">
        <span style="min-width:82px">${label}</span>
        <input type="text" list="lqx-font-list" data-lqx-font="${which}" value="${cur.replace(/"/g, '&quot;')}"
               placeholder="default" spellcheck="false"
               style="flex:1;min-width:0;padding:5px 8px;border-radius:7px;border:0;
                      background:rgba(255,255,255,.08);color:#fff;font:400 12px/1 inherit">
        <select data-lqx-font-pick="${which}" title="Fonts found on this machine"
                style="width:26px;padding:5px 0;border-radius:7px;border:0;cursor:pointer;
                       background:rgba(255,255,255,.08);color:#fff;font:400 12px/1 inherit"></select>
        <span data-lqx-font-ok="${which}" style="min-width:14px;text-align:center;opacity:.75"></span>
      </label>`;
    };
    fonts.innerHTML = `
      <div style="font:600 13px/1.4 inherit;opacity:.9;margin-bottom:4px">Fonts
        <div style="font:400 11px/1.4 inherit;opacity:.55;margin-top:3px">
          Any font installed on this machine, by family name -- not just the
          theme's built-in list. Leave empty for Spotify's own. A tick means the
          name resolves to a real font; a cross means it will fall back.
        </div>
      </div>
      <datalist id="lqx-font-list"></datalist>
      ${fontRow('body', 'Body font')}${fontRow('heading', 'Heading font')}`;
    wrap.appendChild(fonts);
    // Both controls, because they answer different questions and each is wrong
    // on its own. The datalist filters its options against what is typed, which
    // is what you want when searching for a name you already know -- but it also
    // means a field still holding "Space Grotesk" shows no other font at all,
    // which read as "Monocraft isn't detected". The select ignores the field and
    // always lists everything, which is what you want when browsing.
    const fillFonts = (names) => {
      if (!names?.length) return false;
      const esc = (n) => n.replace(/"/g, '&quot;');
      const dl = fonts.querySelector('#lqx-font-list');
      if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
      for (const sel of fonts.querySelectorAll('select[data-lqx-font-pick]')) {
        if (sel.options.length > 1) continue;
        const which = sel.getAttribute('data-lqx-font-pick');
        const input = fonts.querySelector(`input[data-lqx-font="${which}"]`);
        sel.innerHTML = '<option value="">\u25be</option>' +
          names.map((n) => `<option value="${esc(n)}">${n}</option>`).join('');
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          input.value = sel.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          sel.value = '';
        });
      }
      return true;
    };
    // Synchronous when the list is already known, which it is after the first
    // few hundred ms of the session; the promise path only covers a panel
    // opened before detection finished.
    if (!fillFonts(localFonts)) suggestFonts().then(fillFonts);
    for (const input of fonts.querySelectorAll('input[data-lqx-font]')) {
      const which = input.getAttribute('data-lqx-font');
      const mark = fonts.querySelector(`[data-lqx-font-ok="${which}"]`);
      const sync = () => {
        const name = input.value.trim();
        mark.textContent = !name ? '' : fontExists(name) ? '\u2713' : '\u2717';
        mark.style.color = !name ? '' : fontExists(name) ? '#4ade80' : '#f87171';
        input.style.fontFamily = name ? `"${name.replace(/"/g, '')}", inherit` : '';
      };
      input.addEventListener('input', () => { sync(); setFont(which, input.value); });
      sync();
    }
    // FIRST child, not appended. Appending put this block below every one of the
    // theme's own sections and below "Reset all Settings", so in practice it was
    // never found -- the Background section near the top of the panel was where
    // the sliders were being looked for, and those drove the theme's own
    // (invisible) Kawarp canvas instead. These are now the first thing in the
    // panel body, and liquify-fabric-bg stands the theme's animated background
    // down so there is no second, dead set of background controls below.
    // Into the theme's own Background section rather than on top of the panel.
    //
    // Sitting at the top made this a SECOND block headed "Background", above a
    // section of the same name whose own controls this replaced -- two headings
    // and one working set of controls. Nesting it puts the controls under the
    // heading that names them, and keeps the Background button in the tab strip
    // pointing at something, which it would not be if that section were left
    // with nothing in it.
    const bgBody = [...panel.querySelectorAll('.liquifySection')]
      .find((sec) => sec.querySelector('.liquifySectionTitle')?.textContent.trim() === 'Background')
      ?.querySelector('.liquifySectionBody');
    if (bgBody) {
      // The section title already says Background, so this block's own heading
      // goes and its explanation stays. The heading element holds the WORD as a
      // text node and the explanation as its only child element, so replacing
      // the heading with that child drops exactly the duplicate -- taking the
      // first child element instead removes the explanation and keeps the
      // duplicate, which is the wrong way round and looks it.
      const head = wrap.firstElementChild;
      const desc = head?.firstElementChild;
      if (head && desc) {
        desc.style.marginBottom = '10px';
        head.replaceWith(desc);
      }
      wrap.style.borderBottom = 'none';
      bgBody.insertBefore(wrap, bgBody.firstChild);
    } else {
      panel.insertBefore(wrap, panel.firstChild);
    }
    for (const input of wrap.querySelectorAll('input[data-lqx]')) {
      input.addEventListener('input', () => {
        const which = input.getAttribute('data-lqx');
        wrap.querySelector(`[data-lqx-out="${which}"]`).textContent = input.value;
        localStorage.setItem(FABRIC[which].key, input.value);
        window.liquifyFabric?.set({ [which]: parseFloat(input.value) });
      });
    }
  }
  function tryInjectDriftUI() {
    const overlay = document.getElementById('liquify-settings-react-overlay');
    if (!overlay || !overlay.offsetParent) return;
    const panel = overlay.querySelector('.liquifySettingsPanel');
    if (!panel) return;
    // append into the panel's scrolling body if it has one, else the panel
    const body = [...panel.children].find(c => /auto|scroll/.test(getComputedStyle(c).overflowY)) || panel;
    buildDriftUI(body);
  }
  // React re-renders the panel and will drop the injected node; the observer
  // simply puts it back.
  new MutationObserver(tryInjectDriftUI).observe(document.body, { childList: true, subtree: true });
  setInterval(tryInjectDriftUI, 1200);

  window.liquifyDrift = {
    get: driftCfg,
    set(strength, speed) {
      if (strength != null) localStorage.setItem(DRIFT_STRENGTH_KEY, String(strength));
      if (speed != null) localStorage.setItem(DRIFT_SPEED_KEY, String(speed));
      return driftCfg();
    },
  };

  // ---- perf mode (bound to Alt+Shift+P in liquify-keys.js) ----
  const setPerf = (on) => {
    document.documentElement.classList.toggle('liquify-perf', on);
    try { localStorage.setItem(PERF_KEY, on ? 'on' : 'off'); } catch {}
    if (window.Spicetify?.showNotification)
      Spicetify.showNotification(on ? 'Liquify: performance mode ON' : 'Liquify: performance mode OFF');
  };
  setPerf(localStorage.getItem(PERF_KEY) === 'on');

  // The keybinding itself now lives in liquify-keys.js (Alt+Shift+P), because
  // Cmd+P was reassigned to "add track to playlist". Keeping the binding in one
  // file means the two can never disagree about which chord owns what; this
  // side just exposes the toggle.
  window.addEventListener('lqx-toggle-perf', () => {
    setPerf(!document.documentElement.classList.contains('liquify-perf'));
  });


  // ---- dead backdrop-filter elimination ----
  //
  // A `backdrop-filter` forces Chromium to allocate a backdrop render surface
  // and re-composite it every frame, whether or not the filter changes any
  // pixels. Liquid Lyrics ships two `.liquid-lyrics-bg` panels carrying
  // `backdrop-filter: blur(0px)` -- a zero-radius blur is a visual no-op, but
  // measured here they were 657,661 px and 371,520 px of live backdrop surface,
  // ~88% of the viewport between them. Elements at opacity 0 pay the same cost
  // for pixels nobody sees.
  //
  // This nulls the filter only where it provably cannot change the output, so
  // it is visually lossless. Anything with a url(#...) refraction is left alone.

  const NOOP_ATTR = 'data-lqx-noop';
  const isNoOpBackdrop = (v) => !!v && v !== 'none' && !v.includes('url(') && /^blur\(0(?:px|\.0*px)?\)$/.test(v.trim());

  function sweepDeadGlass() {
    if (window.__lqxNoSweep) return;   // benchmark escape hatch
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none') {
        if (el.hasAttribute(NOOP_ATTR) && !el.style.backdropFilter) el.removeAttribute(NOOP_ATTR);
        continue;
      }
      const dead = isNoOpBackdrop(bf) || parseFloat(cs.opacity) === 0 || cs.visibility === 'hidden';
      if (dead && !el.hasAttribute(NOOP_ATTR)) {
        el.setAttribute(NOOP_ATTR, '1');
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
      } else if (!dead && el.hasAttribute(NOOP_ATTR)) {
        el.removeAttribute(NOOP_ATTR);
        el.style.removeProperty('backdrop-filter');
        el.style.removeProperty('-webkit-backdrop-filter');
      }
    }
  }

  let sweepQueued = false;
  const scheduleSweep = () => {
    if (sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => { sweepQueued = false; sweepDeadGlass(); }, 400);
  };
  sweepDeadGlass();
  setInterval(scheduleSweep, 2000);
  new MutationObserver(scheduleSweep).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'], subtree: true, childList: true });

  window.liquifyPerf = { setPerf, sweepDeadGlass, get enabled() { return document.documentElement.classList.contains('liquify-perf'); } };
})();
