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
  // `[data-liquify]` beats Liquify's own per-instance rules, which are appended
  // to <head> as each GlassSurface is constructed.
  style.textContent =
    `:root, html [data-liquify]{--glass-filter:url(#${ID}-hi) !important;--liquify-filter:url(#${ID}-hi) !important;}` +
    `html [data-liquify]:is(${SMALL}), html :is(${SMALL}){--glass-filter:url(#${ID}-lo) !important;--liquify-filter:url(#${ID}-lo) !important;}`;
  document.head.appendChild(style);


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
  bgStyle.textContent = `
    .liquify-bg-layer {
      width: ${100 / BG_SCALE}vw !important;
      height: ${100 / BG_SCALE}vh !important;
      right: auto !important;
      bottom: auto !important;
      transform: scale(${BG_SCALE}) !important;
      transform-origin: 0 0 !important;
      filter: blur(${(7 / BG_SCALE).toFixed(2)}px) brightness(0.45) !important;
    }
    html.liquify-perf .liquify-bg-layer {
      width: ${100 / (BG_SCALE * 2)}vw !important;
      height: ${100 / (BG_SCALE * 2)}vh !important;
      transform: scale(${BG_SCALE * 2}) !important;
      filter: blur(${(7 / (BG_SCALE * 2)).toFixed(2)}px) brightness(0.45) !important;
    }`;
  document.head.appendChild(bgStyle);

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
