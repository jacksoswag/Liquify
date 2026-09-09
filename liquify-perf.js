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
  // Two different things wear the name "shadow" in this theme and they have
  // nothing in common performance-wise:
  //
  //   1. Outer drop shadows (Spotify's own, on cards/modals/overlays). Large
  //      blur radii; each is a separate rasterization of a blurred alpha mask.
  //      These are the expensive ones and they stay dropped.
  //
  //   2. Liquify's specular rim -- `--liquify-shadow`, three *inset* 1px
  //      highlights (bright top edge, bottom glow, hairline outline) applied
  //      to 223 selectors, 39 of them `::after` overlays covering whole panels.
  //      These are what make the glass read as glass. A 1px inset shadow is
  //      painted inside the element's own display list: no separate surface,
  //      no blur pass, no per-frame cost.
  //
  // The first version of this file killed both with one `*` rule, which took
  // the rim with it. The selector list below is extracted verbatim from
  // user.css so the rim is restored exactly where the theme put it -- nowhere
  // else, and never on an element the theme did not choose.
  const RIM = `
  .main-globalNav-searchInputContainer .main-topBar-searchBar,.kJKdTjeNSBY8tT1B,.zddkQq3wlxEOg6aa,
  .Root__globalNav .main-globalNav-navLink,.main-topBar-buddyFeed,.main-userWidget-box,
  .main-globalNav-historyButtons,.HqUgEQOPyVcDu2NW:hover,.Root__main-view::after,.Root__right-sidebar::after,
  .main-nowPlayingView-coverArt::after,.main-nowPlayingView-section::after,.main-entityHeader-image::after,
  .zPBFT1LAMAuacsb6::after,.view-homeShortcutsGrid-shortcut .view-homeShortcutsGrid-imageWrapper::after,
  .ceHJbDWktNYBqkcL::after,.PromotionDefaultNativeImage-module_image-container__gQhJp::after,
  .main-cardImage-imageWrapper::after,.DdDQ_LY0sYLt8LxK::after,.PrxpYQpIB876tjO6::after,
  .J8g7rZ2MDknxmiYP::after,.lib2URAlzM4k2T_a .ckC1howZfkU9dexz.Dxar5n2kotgdT0zL::after,
  .UQtkWvPf1V4H5Cb0 .IRLnJsXXcFoBCxbX::after,.KqsfjxDhIg8NevcC::after,.WRAJX50Owww6lGwsw::after,
  .qm0mrbeno_z0mpoo::after,.f2AfA4jDLWwihiQO::after,.Root__cinema-view::after,.P8ZiZf6Nbowk6zjL::after,
  .Gg1Ahel4Ik0T9YSl::after,.e-10451-button-icon-only--large::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-bright-accent-set.e-10451-button-icon-only--medium::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-inverted-light-set.e-10451-legacy-button--medium::after,
  .main-nowPlayingWidget-coverArtContainer::after,.Root__nav-bar::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-inverted-light-set.e-10451-button-icon-only--medium::after,
  .DHOpYzKPUqobiHLW::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.e-10451-legacy-button--small::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-bright-accent-set.e-10451-legacy-button--medium.V2fMzLP0dWw4E5zO::after,
  .button-module__button___hf2qg_marketplace::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-negative-set.e-10451-legacy-button--medium.V2fMzLP0dWw4E5zO::after,
  .view-homeShortcutsGrid-shortcut .view-homeShortcutsGrid-PlayButtonContainer .view-homeShortcutsGrid-playButton::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-bright-accent-set.e-10451-legacy-button--medium::after,
  span.e-10451-overflow-wrap-anywhere.e-10451-button-primary__inner.encore-bright-accent-set.e-10451-legacy-button--large::after,
  span.e-10810-overflow-wrap-anywhere.e-10810-button-primary__inner.encore-bright-accent-set.e-10810-button-icon-only--large::after,
  span.e-10810-overflow-wrap-anywhere.e-10810-button-primary__inner.encore-bright-accent-set.e-10810-button-icon-only--medium::after,
  span.e-10810-overflow-wrap-anywhere.e-10810-button-primary__inner.encore-inverted-light-set.e-10810-button-icon-only--medium::after,
  .view-homeShortcutsGrid-shortcut,.main-home-filterChipsSection,.sdEd4DOwfUAWrygb,.NJh1B8rnlSUlK7sY,
  .Oy9aO87dDlgDS8lf,.Oy9aO87dDlgDS8lf:hover,.we0UJfWAf8vWXQku,.x-filterBox-expandButton,
  button.e-10451-legacy-button.e-10451-legacy-button-tertiary.e-10451-overflow-wrap-anywhere.encore-text-body-small-bold.e-10451-legacy-button--small.e-10451-button-tertiary--small.e-10451-button--trailing.e-10451-button-tertiary--condensed.e-10451-button-tertiary--text-subdued.encore-internal-color-text-subdued,
  .search-searchCategory-carouselButton,.aE_ayHuwU0UG20h2:hover,.e-10451-box--tinted,
  .main-nowPlayingView-headerWrapper,.e-10451-legacy-button-secondary,
  button.e-10451-legacy-button.e-10451-legacy-button-tertiary.e-10451-overflow-wrap-anywhere.e-10451-button-tertiary--icon-only-small.e-10451-button-tertiary--icon-only.e-10451-button-tertiary--text-subdued.encore-internal-color-text-subdued.main-nowPlayingView-headerButton,
  .main-nowPlayingView-trackInfo,.pHNOePN5RT09utW9 .g3QSV3tq49ScV2jX,.iiX8td2tfVETS09_ button,
  .orFyQFu0kG4H73ty:hover,.e-10451-tab-item:hover,
  .e-10451-box.e-10451-box--naked.e-10451-box--interactive.e-10451-box--padding-custom.e-10451-box--padding-block-start-custom.e-10451-box--padding-block-end-custom.e-10451-box--hover-custom.e-10451-box--min-size.e-10451-legacy-list-row.e-10451-legacy-list-row--has-leading.Z557o5iO1x0aSAXt.main-useDropTarget-base.main-useDropTarget-track.main-useDropTarget-local.main-useDropTarget-episode.kCuoeTp_4F8B1vXL.main-useDropTarget-album:hover,
  .e-10451-box.e-10451-box--naked.e-10451-box--interactive.e-10451-box--padding-custom.e-10451-box--padding-block-start-custom.e-10451-box--padding-block-end-custom.e-10451-box--hover-custom.e-10451-box--min-size.e-10451-legacy-list-row.e-10451-legacy-list-row--has-leading.Z557o5iO1x0aSAXt.main-useDropTarget-base:hover,
  .gpBiAnJHb1gq46qV,.yMgvi79CxA6kU0bR,.SMa1MaSqKoADr7I1,.main-nowPlayingView-artistOnTourItem:focus-within,
  .main-nowPlayingView-artistOnTourItem:hover,.main-nowPlayingView-onTourTimeCard.WrTYC19GTA8avoBQ,dialog,
  .main-trackCreditsModalV2-closeBtn,.EU1ylDKh7s2oMU0g,.VwcQJ4Zsf0JKD3Ls,.Q63Qxcm2ngQYyluw,.uu9s9Uba3tQf6ExH,
  .KQDsZX3kwwuAFpE8,.main-nowPlayingView-actionButton,.k5cq5CRdOO8TaJlA:hover,.Root__now-playing-bar,
  .main-connectBar-connectBar.main-connectBar-connected,.KFAJvMWTSagxYXGC,.JDUQ8zTo6EUgHoYt,.B9ji6YIpLSUHiyxx,
  .GVOWlzcZSE5JbfWf,.gu0S9_98ZXIo5DaV,.SUjhgyMvTou7TddO,.mwk3Wc6l_icG6VO7:hover,.n5KI8mwa5o8qbn4b,
  .vado7sbDrEsKhSmn,.main-topBar-background,.main-trackList-trackListHeader,.main-entityHeader-container,
  .main-actionBar-ActionBar,.e-10451-legacy-chip__inner,.x-sortBox-sortDropdown,.f0DRpgeIxygEki9e,
  .x-filterBox-filterInput,.main-contextMenu-tippy,.PromotionButtonTooltip-module_tooltip-animation__cE-rt,
  .e-10451-chip-clear,.main-trackList-trackListRow.q8suB2R_XkoUyIeZ,.main-trackList-trackListRow:hover,
  .main-editImageButton-image,.main-playlistEditDetailsModal-container,
  .main-playlistEditDetailsModal-titleInput,.main-playlistEditDetailsModal-descriptionTextarea,
  .main-playlistEditDetailsModal-imageDropDownButton,.main-playlistEditDetailsModal-closeBtn,
  .main-card-cardContainer,.UP4sKQB2oWdHEMOE,.uJT7C8StdDMdgcva,.os-scrollbar-handle,.ERRo1Br0ZQtJYVhz,
  .LR7w41pC8ccVc11Q,.VsYY0YB3c4lmhoDI,.YT5cYwULCoyD6pGh,.iaaQKMqcyZQBT9bn,.main-shelf-shelf,.cTnmA013TQbGR3SF,
  .CO34wNPAbR8mpcdD,.JthDv0xUCm8rLhu6,.tlq9Tt69FX4bauLX,.x-settings-section,.main-dropDown-dropDown,
  .GprrtSWlnCwoNzut,.x-settings-zoomContainer,.x-settings-equalizerSection,.x-settings-outputDeviceSection,
  .x-settings-zoomButtonIconWrapper,.main-embedWidgetGenerator-container,.spicetify-exp-features input.search,
  .InxeMZqTiY9YIYgh,.ezToExEhEDEdAkV4,.TguLwQ522LIEgpK_.IxVxBUbV5M5tGaEx,.HOf9H18Ya0DkJ4_K,.e-10451-tag,
  .main-nowPlayingView-onTourItemGrid:hover,.main-nowPlayingView-onTourTimeCard,.mp57tCaTzo7_wVHK,
  .HX8Y5HwR9P0JHU9S,.N3kf5S8O84aeaCZu,.spicetify-exp-features button.switch,.e-10451-box--elevated,
  .Wzl40f9FIUD91O2o,.kPNLJ4R0r0LWySog,.ZnAo42EPyLw72WLD,.yXN52o27ZsCRQpNt:after,.x-entityImage-imageContainer,
  .Htdd9HRV28F07Dwl,.KRcMJBwxHSMuQhZa,.p67WtOnm9lsRLOu2,.JLkvt5ABTQYw_rG7,.dyNR5Zzrff43h3r0,.mKvcoJ_veYlcHwOz,
  .BIQHixxXGx0NzXS9,.U6mTgLEk5kVVRmKF,.tMcqYZ2om0nYbgrw,.ladI0V8GNBwaliFh:is(:hover,:focus-visible),
  .yZCluNwEsPD2zYyY,.YYR31GkgSNQaEQIc:hover,
  button.e-10451-legacy-button.e-10451-legacy-button-tertiary.e-10451-overflow-wrap-anywhere.e-10451-button-tertiary--icon-only-small.e-10451-button-tertiary--icon-only.e-10451-button-tertiary--text-subdued.encore-internal-color-text-subdued.KGKmD8XXCDYOhmAx,
  .Hrce4GF4EEkPJdBI,.DGYls4SVbuwGxQhk,.JIoapLEXN1k37B2h,.EpfIE3glwAOGcNT6,
  .main-contextMenu-menu.liquify-glass--before::before,.xamNkt5LX9o8aL1q.liquify-glass--before::before,
  .main-contextMenu-menuItemButton:not([aria-checked=true]):focus,.main-contextMenu-menuItemButton:hover,
  .main-contextMenu-menuItemButton[aria-expanded=true],.gke5k3GmXyE2J5Pm:hover>:first-child,.marketplace-header,
  .marketplace-tabBar-active,.Dropdown-control,.marketplace-header-icon-button,.searchbar-bar,.Dropdown-menu,
  .Dropdown-option.is-selected,.Dropdown-option:hover,.main-card-card,#marketplace-readme,
  #marketplace-readme details,#marketplace-readme code,
  .marketplace-grid .main-card-draggable .main-card-cardMetadata li.marketplace-card__tag,
  .marketplace-grid .main-card-draggable .main-card-cardMetadata .marketplace-card__tags-more-btn,
  .mTKn24eZtKM0ouGv:hover,.iq16tKI_q90F_cM1,.uAMtSVze_YEzqBxh,._kx6PbIX2n8MJzEV,.WuleKmKt7kwEObvJ,
  .artist-artistDiscography-topBar.artist-artistDiscography-topBarScrolled,.oc3OomY6r9UoIEQ0,
  .LayoutResizer__inline-end:after,.LayoutResizer__inline-start:after,.oReO3E1Df2odSFHX,.iNb3XBh2XIAzQhHc,
  button.e-10451-legacy-button.e-10451-legacy-button-tertiary.e-10451-overflow-wrap-anywhere.e-10451-button-tertiary--icon-only-small.e-10451-button-tertiary--icon-only.encore-internal-color-text-base.encore-over-media-set.ke_VP4xHdoJFnTJT,
  .main-trackCreditsModal-container,.iWVdKqonjP0bx_gM,
  .main-yourLibraryX-libraryItemContainer .os-scrollbar-vertical:active .os-scrollbar-handle[data-group-by]:after,
  .h0PQ8sOpdOAqPvpi:focus-within,.h0PQ8sOpdOAqPvpi:hover,.edvX5XPBIXITSQoH,.TGvpaalpJK0BKYYL,
  .X8iDE4nRFc6Fz1ua:not(.iWYXfFRVugfeZGTY):hover,.o1ikq4AVMKwiMyZ8,.cMZUj2dVUwneYo6e,.xFmkDiiqFwn5W_mx:hover,
  .e-10810-legacy-chip__inner,.e-10810-legacy-button-secondary,.e-10810-tab-item:hover,
  .e-10810-legacy-box.e-10810-legacy-box--naked.e-10810-legacy-box--interactive.e-10810-legacy-box--padding-custom.e-10810-legacy-box--padding-block-start-custom.e-10810-legacy-box--padding-block-end-custom.e-10810-legacy-box--hover-custom.e-10810-legacy-box--min-size.e-10810-legacy-list-row.e-10810-legacy-list-row--has-leading.Z557o5iO1x0aSAXt.main-useDropTarget-base.main-useDropTarget-track.main-useDropTarget-local.main-useDropTarget-episode.kCuoeTp_4F8B1vXL.main-useDropTarget-album:hover,
  .e-10810-legacy-box.e-10810-legacy-box--naked.e-10810-legacy-box--interactive.e-10810-legacy-box--padding-custom.e-10810-legacy-box--padding-block-start-custom.e-10810-legacy-box--padding-block-end-custom.e-10810-legacy-box--hover-custom.e-10810-legacy-box--min-size.e-10810-legacy-list-row.e-10810-legacy-list-row--has-leading.Z557o5iO1x0aSAXt.main-useDropTarget-base:hover,
  .e-10810-legacy-box--tinted,.main-nowPlayingView-headerButton,.J3ndazz3tjkb4CYQ:before`;

  const shadowStyle = document.createElement('style');
  shadowStyle.id = ID + '-shadows';
  shadowStyle.textContent = `
    *, *::before, *::after { box-shadow: none !important; text-shadow: none !important; }

    /* restore the specular rim (see note above) */
    ${RIM} { box-shadow: var(--liquify-shadow) !important; }

    /* keep the cover-art drop shadow: it is a single small element and it is
       what gives the floating card its depth */
    .main-nowPlayingView-coverArt, .liquid-lyrics-song-card {
      filter: drop-shadow(0 9px 9px rgba(0,0,0,.271)) !important;
    }`;
  document.head.appendChild(shadowStyle);


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
