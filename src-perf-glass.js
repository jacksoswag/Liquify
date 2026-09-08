(() => {
  const ID = 'lqx';
  if (window.__lqx) window.__lqx.teardown();

  // ---- 1. ONE shared filter, raster displacement map (no per-element SVG rasterization) ----
  function rasterMap(w, h, r, edgePct, blurPx) {
    // Build the displacement map once, on a canvas -> PNG. Skia blits a raster
    // feImage; rasterizing an SVG data-URI inside the filter graph is the slow path.
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const rg = x.createLinearGradient(w, 0, 0, 0);
    rg.addColorStop(0, 'rgba(255,0,0,0)'); rg.addColorStop(1, 'rgba(255,0,0,1)');
    const bg = x.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(0,0,255,0)'); bg.addColorStop(1, 'rgba(0,0,255,1)');
    const rr = (X, Y, W, H, R) => { x.beginPath(); x.roundRect(X, Y, W, H, R); x.fill(); };
    x.globalCompositeOperation = 'source-over'; x.fillStyle = rg; rr(0, 0, w, h, r);
    x.globalCompositeOperation = 'screen';      x.fillStyle = bg; rr(0, 0, w, h, r);
    x.globalCompositeOperation = 'source-over';
    const e = Math.min(w, h) * edgePct;
    x.filter = `blur(${blurPx}px)`;
    x.fillStyle = 'rgba(128,128,128,0.93)';
    rr(e, e, w - e * 2, h - e * 2, r);
    x.filter = 'none';
    return c.toDataURL('image/png');
  }

  const NS = 'http://www.w3.org/2000/svg';
  const fe = (n, a) => { const el = document.createElementNS(NS, n); for (const k in a) el.setAttribute(k, a[k]); return el; };

  function buildFilter(id, { scale, chroma, mapHref, post }) {
    const f = fe('filter', { id, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
    const img = fe('feImage', { x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'map' });
    img.setAttribute('href', mapHref);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', mapHref);
    f.appendChild(img);
    if (chroma) {
      const ch = [['Red', 0, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
                  ['Green', 6, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
                  ['Blue', 10, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']];
      for (const [n, off, m] of ch) {
        f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: String(scale + off), xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + n }));
        f.appendChild(fe('feColorMatrix', { in: 'd' + n, type: 'matrix', values: m, result: n.toLowerCase() }));
      }
      f.appendChild(fe('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'rg' }));
      f.appendChild(fe('feBlend', { in: 'rg', in2: 'blue', mode: 'screen', result: 'out' }));
      if (post) f.appendChild(fe('feGaussianBlur', { in: 'out', stdDeviation: String(post) }));
    } else {
      // single displacement pass — 2 primitives total instead of 9
      f.appendChild(fe('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: String(scale + 5), xChannelSelector: 'R', yChannelSelector: 'G', result: 'out' }));
      if (post) f.appendChild(fe('feGaussianBlur', { in: 'out', stdDeviation: String(post) }));
    }
    return f;
  }

  const host = fe('svg', { id: ID + '-host', width: '0', height: '0', 'aria-hidden': 'true' });
  const defs = document.createElementNS(NS, 'defs');
  const map = rasterMap(400, 200, 20, 0.035, 2);
  defs.appendChild(buildFilter(ID + '-hi', { scale: -80, chroma: true,  mapHref: map, post: 0.2 })); // large surfaces
  defs.appendChild(buildFilter(ID + '-lo', { scale: -80, chroma: false, mapHref: map, post: 0 }));   // small controls
  host.appendChild(defs);
  document.body.appendChild(host);

  window.__lqx = {
    map,
    teardown() {
      document.getElementById(ID + '-host')?.remove();
      document.getElementById(ID + '-style')?.remove();
    }
  };
  return { ok: true, mapBytes: map.length };
})()
