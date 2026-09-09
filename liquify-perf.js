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
// Small controls drop the chromatic-aberration passes (9 primitives -> 2); the
// RGB fringe is sub-pixel at button size and the 2px output blur erases it.

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

  function buildFilter(id, { scale, chroma, href, post }) {
    const f = fe('filter', { id, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
    const img = fe('feImage', { x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'map' });
    img.setAttribute('href', href);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    f.appendChild(img);
    if (chroma) {
      for (const [n, off, m] of [
        ['Red', 0, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['Green', 6, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['Blue', 10, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']]) {
        f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: String(scale + off), xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + n }));
        f.appendChild(fe('feColorMatrix', { in: 'd' + n, type: 'matrix', values: m, result: n.toLowerCase() }));
      }
      f.appendChild(fe('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'rg' }));
      f.appendChild(fe('feBlend', { in: 'rg', in2: 'blue', mode: 'screen', result: 'out' }));
    } else {
      f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: String(scale + 5), xChannelSelector: 'R', yChannelSelector: 'G', result: 'out' }));
    }
    if (post) f.appendChild(fe('feGaussianBlur', { in: 'out', stdDeviation: String(post) }));
    return f;
  }

  const host = fe('svg', { id: ID + '-host', width: '0', height: '0', 'aria-hidden': 'true' });
  host.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none');
  const defs = document.createElementNS(NS, 'defs');
  const map = rasterMap(400, 200, 20, 0.035, 2);
  defs.appendChild(buildFilter(ID + '-hi', { scale: -80, chroma: true,  href: map, post: 0.2 }));
  defs.appendChild(buildFilter(ID + '-lo', { scale: -80, chroma: false, href: map, post: 0 }));

  // ---- evolving "drift" distortion on the album background ----
  //
  // A slow, non-repeating global warp, in the spirit of the Drift screensaver:
  // no visible swirl centre, just the whole image breathing.
  //
  // Why this is affordable when the theme's other filters were not: the
  // background layer is now rendered into a ~317x231 backing store (see below),
  // so the displacement pass covers ~73k px, not the 1.17M px it used to. And
  // crucially the noise field is a STATIC raster - generated once here - that is
  // merely *translated* by an animated feOffset. Translating a cached texture is
  // nearly free, whereas animating feTurbulence's baseFrequency would re-evaluate
  // procedural noise per pixel per frame, which is exactly the kind of work that
  // made the original theme expensive.
  //
  // Two feOffset animations with coprime-ish periods (47s / 61s) means the pair
  // does not revisit the same offset for ~48 minutes, so it never visibly loops.

  // Displacement offset is `scale * (channel/255 - 0.5)`. Blurring random noise
  // pulls every channel toward the 128 mid-point, i.e. toward ZERO displacement
  // -- the first version of this was invisible for exactly that reason. So after
  // smoothing we contrast-stretch each channel back to the full 0..255 range,
  // which restores amplitude while keeping the field smooth.
  function noiseTexture(size, cell, blurPx) {
    const small = document.createElement('canvas');
    small.width = small.height = cell;
    const sx = small.getContext('2d');
    const img = sx.createImageData(cell, cell);
    for (let i = 0; i < cell * cell; i++) {
      img.data[i * 4 + 0] = Math.random() * 255;   // R -> x displacement
      img.data[i * 4 + 1] = Math.random() * 255;   // G -> y displacement
      img.data[i * 4 + 2] = 128;
      img.data[i * 4 + 3] = 255;
    }
    sx.putImageData(img, 0, 0);
    const mid = document.createElement('canvas');
    mid.width = mid.height = size;
    const mx = mid.getContext('2d');
    mx.imageSmoothingEnabled = true;
    mx.imageSmoothingQuality = 'high';
    mx.drawImage(small, 0, 0, size, size);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ox = out.getContext('2d');
    if (blurPx > 0) ox.filter = `blur(${blurPx}px)`;
    ox.drawImage(mid, 0, 0);
    ox.filter = 'none';
    const d = ox.getImageData(0, 0, size, size);
    let lo = [255, 255], hi = [0, 0];
    for (let i = 0; i < d.data.length; i += 4)
      for (let c = 0; c < 2; c++) {
        const v = d.data[i + c];
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    for (let i = 0; i < d.data.length; i += 4)
      for (let c = 0; c < 2; c++) {
        const span = Math.max(1, hi[c] - lo[c]);
        d.data[i + c] = Math.max(0, Math.min(255, ((d.data[i + c] - lo[c]) / span) * 255));
      }
    ox.putImageData(d, 0, 0);
    return out.toDataURL('image/png');
  }

  // ---- drift settings (persisted; also exposed in Liquify's settings panel) ----
  const CHROMA_KEY = 'liquify-glass-chromatic';          // 'on' | 'off'
  const chromaOn = () => localStorage.getItem(CHROMA_KEY) === 'on';
  const DRIFT_STRENGTH_KEY = 'liquify-drift-strength';   // 0-100, 0 = off
  const DRIFT_SPEED_KEY    = 'liquify-drift-speed';      // 1-100, higher = faster
  const readNum = (k, dflt) => { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : dflt; };
  const driftCfg = () => ({
    strength: Math.max(0, Math.min(100, readNum(DRIFT_STRENGTH_KEY, 0))),
    speed:    Math.max(1, Math.min(100, readNum(DRIFT_SPEED_KEY, 65))),
  });

  const DRIFT_ID = ID + '-drift';
  const NOISE_HREF = noiseTexture(320, 9, 3);

  function buildDriftFilter() {
    const { strength, speed } = driftCfg();
    // The layer is drawn at 1/BG_SCALE and scaled back up, so displacement in
    // this space is multiplied by BG_SCALE on screen. strength 100 ~ 100px.
    const scale = (strength / 100) * (100 / 4);
    const base = 150 - speed;            // seconds; two coprime-ish periods
    const f = fe('filter', { id: DRIFT_ID, 'color-interpolation-filters': 'sRGB',
                             x: '-15%', y: '-15%', width: '130%', height: '130%' });
    const img = fe('feImage', { x: '-15%', y: '-15%', width: '130%', height: '130%',
                                preserveAspectRatio: 'none', result: 'noise' });
    img.setAttribute('href', NOISE_HREF);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', NOISE_HREF);
    f.appendChild(img);
    const off = fe('feOffset', { in: 'noise', dx: '0', dy: '0', result: 'drift' });
    const anim = (attr, values, dur) => {
      const a = document.createElementNS(NS, 'animate');
      a.setAttribute('attributeName', attr);
      a.setAttribute('values', values);
      a.setAttribute('dur', dur + 's');
      a.setAttribute('repeatCount', 'indefinite');
      a.setAttribute('calcMode', 'spline');
      a.setAttribute('keyTimes', '0;0.33;0.66;1');
      a.setAttribute('keySplines', '.45 0 .55 1;.45 0 .55 1;.45 0 .55 1');
      return a;
    };
    off.appendChild(anim('dx', '0;26;-21;0', Math.round(base * 0.78)));
    off.appendChild(anim('dy', '0;-19;24;0', Math.round(base)));
    f.appendChild(off);
    f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'drift',
      scale: String(scale.toFixed(1)), xChannelSelector: 'R', yChannelSelector: 'G' }));
    return f;
  }
  defs.appendChild(buildDriftFilter());

  function rebuildDrift() {
    document.getElementById(DRIFT_ID)?.remove();
    defs.appendChild(buildDriftFilter());
    applyBgStyle();
  }

  host.appendChild(defs);
  document.body.appendChild(host);

  // Controls small enough that the chromatic fringe is invisible.
  const SMALL = [
    '.main-globalNav-historyButtons', '.main-nowPlayingView-actionButton', '.os-scrollbar-handle',
    '.search-searchCategory-carouselButton', '.main-home-filterChipsSection', '.main-userWidget-box',
    'button', '.e-10810-legacy-button', '.e-10810-form-input', '.liquid-lyrics-control-pill'
  ].join(',');

  const style = document.createElement('style');
  style.id = ID + '-style';
  document.head.appendChild(style);
  function applyGlassStyle() {
    // Measured, paired, 6 cycles with drift off: the 3-pass chromatic chain
    // costs 32 GPU points (77.2% -> 44.8%) for an RGB fringe that is sub-pixel
    // at blur(2px). Single-pass keeps the refraction/warping identical, so it
    // is the default; chromatic is opt-in.
    const hi = chromaOn() ? ID + '-hi' : ID + '-lo';
    style.textContent =
      `:root, html [data-liquify]{--glass-filter:url(#${hi}) !important;--liquify-filter:url(#${hi}) !important;}` +
      `html [data-liquify]:is(${SMALL}), html :is(${SMALL}){--glass-filter:url(#${ID}-lo) !important;--liquify-filter:url(#${ID}-lo) !important;}`;
  }
  applyGlassStyle();


  // ---- low-resolution album background ----
  //
  // `.liquify-bg-layer` is the album art behind everything: position:fixed,
  // inset:0, background-size:cover, running a live `blur(7px) brightness(.45)`
  // over the full viewport -- two of them, ~1.17M px each. Measured, CSS
  // `filter` on these layers is worth ~20 GPU points, far more than the
  // `opacity:0` animated tiles Chromium already skips.
  //
  // The layer is heavily blurred, so it does not need full resolution. Render
  // it into a 1/4-linear (1/16-area) box and scale it back up, dividing the
  // blur radius to match. 1,170,708 px -> 73,227 px of backing store per layer,
  // and the upscale filtering contributes softening of its own. Visually
  // indistinguishable at this blur radius.

  const BG_SCALE = 4;
  const bgStyle = document.createElement('style');
  bgStyle.id = ID + '-bg';
  document.head.appendChild(bgStyle);
  function applyBgStyle() {
    const on = driftCfg().strength > 0;
    // 27vw/27vh (not 25) gives overscan so drift never pulls transparent pixels
    // in from outside the layer's own bounds.
    bgStyle.textContent = `
      .liquify-bg-layer {
        left: -1vw !important;
        top: -1vh !important;
        width: ${(100 / BG_SCALE) + 2}vw !important;
        height: ${(100 / BG_SCALE) + 2}vh !important;
        right: auto !important;
        bottom: auto !important;
        transform: scale(${BG_SCALE}) !important;
        transform-origin: 0 0 !important;
        filter: ${on ? `url(#${DRIFT_ID}) ` : ''}blur(${(7 / BG_SCALE).toFixed(2)}px) brightness(0.45) !important;
      }
      html.liquify-perf .liquify-bg-layer {
        width: ${(100 / (BG_SCALE * 2)) + 2}vw !important;
        height: ${(100 / (BG_SCALE * 2)) + 2}vh !important;
        transform: scale(${BG_SCALE * 2}) !important;
        filter: blur(${(7 / (BG_SCALE * 2)).toFixed(2)}px) brightness(0.45) !important;
      }`;
  }
  applyBgStyle();

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
  // appends a small section of its own when the panel opens, reusing the
  // panel's classes so it matches. Values persist in localStorage and rebuild
  // the filter live.
  const SETTINGS_MARK = 'data-lqx-drift-ui';
  function buildDriftUI(panel) {
    if (panel.querySelector(`[${SETTINGS_MARK}]`)) return;
    const cfg = driftCfg();
    const wrap = document.createElement('div');
    wrap.setAttribute(SETTINGS_MARK, '1');
    wrap.style.cssText = 'padding:14px 4px 4px;border-top:1px solid rgba(255,255,255,.12);margin-top:14px';
    wrap.innerHTML = `
      <div style="font:600 13px/1.4 var(--liquify-font,inherit);opacity:.9;margin-bottom:10px">
        Background drift
        <div style="font:400 11px/1.4 inherit;opacity:.55;margin-top:3px">
          Slow evolving distortion of the album background. Measured at ~21 GPU
          points at strength 55 -- more than every other optimisation here saves
          combined, so it ships off. 0 disables it entirely.
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:10px;margin:8px 0;font:400 12px/1 inherit;opacity:.85">
        <span style="min-width:62px">Strength</span>
        <input type="range" min="0" max="100" step="1" value="${cfg.strength}" data-lqx="strength" style="flex:1">
        <span data-lqx-out="strength" style="min-width:28px;text-align:right;opacity:.7">${cfg.strength}</span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;margin:8px 0;font:400 12px/1 inherit;opacity:.85">
        <span style="min-width:62px">Speed</span>
        <input type="range" min="1" max="100" step="1" value="${cfg.speed}" data-lqx="speed" style="flex:1">
        <span data-lqx-out="speed" style="min-width:28px;text-align:right;opacity:.7">${cfg.speed}</span>
      </label>`;
    const chroma = document.createElement('div');
    chroma.style.cssText = 'margin-top:14px';
    chroma.innerHTML = `
      <div style="font:600 13px/1.4 inherit;opacity:.9;margin-bottom:4px">Chromatic aberration
        <div style="font:400 11px/1.4 inherit;opacity:.55;margin-top:3px">
          RGB fringing on the glass edges. Measured at ~32 GPU points; the warping
          refraction is unaffected either way.
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:10px;margin:8px 0;font:400 12px/1 inherit;opacity:.85">
        <input type="checkbox" data-lqx-chroma ${chromaOn() ? 'checked' : ''}>
        <span>Enable (costs GPU)</span>
      </label>`;
    wrap.appendChild(chroma);
    chroma.querySelector('[data-lqx-chroma]').addEventListener('change', (e) => {
      localStorage.setItem(CHROMA_KEY, e.target.checked ? 'on' : 'off');
      applyGlassStyle();
    });
    panel.appendChild(wrap);
    for (const input of wrap.querySelectorAll('input[data-lqx]')) {
      input.addEventListener('input', () => {
        const which = input.getAttribute('data-lqx');
        wrap.querySelector(`[data-lqx-out="${which}"]`).textContent = input.value;
        localStorage.setItem(which === 'strength' ? DRIFT_STRENGTH_KEY : DRIFT_SPEED_KEY, input.value);
        rebuildDrift();
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
      rebuildDrift();
      return driftCfg();
    },
  };

  // ---- perf mode: cmd+P / ctrl+P ----
  const setPerf = (on) => {
    document.documentElement.classList.toggle('liquify-perf', on);
    try { localStorage.setItem(PERF_KEY, on ? 'on' : 'off'); } catch {}
    if (window.Spicetify?.showNotification)
      Spicetify.showNotification(on ? 'Liquify: performance mode ON' : 'Liquify: performance mode OFF');
  };
  setPerf(localStorage.getItem(PERF_KEY) === 'on');

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); e.stopPropagation();
      setPerf(!document.documentElement.classList.contains('liquify-perf'));
    }
  }, true);


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
