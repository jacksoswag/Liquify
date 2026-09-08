// liquify-glass-gl — consolidated WebGL glass pipeline.
//
// Replaces, in one GPU pass each:
//   * .liquify-bg-layer         (2 full-viewport CSS `filter: blur()` layers)
//   * the SVG drift filter      (feImage -> feOffset -> feDisplacementMap, re-run every frame)
//   * every `backdrop-filter`   (~90 independent snapshot/filter/composite cycles)
//
// Measured budget this is aimed at (paired, lyrics panel dismissed):
//   glass 15.0 pts | drift 8.5 pts | bg-layer filters 4.4 pts  = 27.9 of 34.3
//
// The architecture is the one iOS uses: blur the backdrop ONCE into a
// downsampled texture, then draw one quad per glass surface with a single
// fragment shader that does rounded-rect SDF -> refraction -> chromatic taps ->
// specular. Drift is free here: refraction already performs a dependent texture
// read, so a time-varying noise offset on that same read is a couple of extra
// instructions rather than a whole separate full-screen filter graph.
//
// Limitation: a WebGL canvas cannot sample DOM pixels, so these panels refract
// the BACKGROUND only. Surfaces that must refract scrolling content stay on CSS
// backdrop-filter (see KEEP_CSS_GLASS).
//
// STATUS: EXPERIMENTAL, NOT ENABLED, AND CURRENTLY WRONG.
//
// The pipeline itself works end to end -- WebGL2 context, both shader programs
// compile and link, the shared blur texture uploads, quads are emitted per glass
// rect (8 on a home view), CSS glass is suppressed on those surfaces, and drift
// runs inside the shader for free. What it renders is NOT acceptable.
//
// The reason is the limitation noted above, and it is fundamental rather than a
// bug to fix: a WebGL canvas cannot sample DOM pixels. Every one of these panels
// therefore refracts ONLY the album background. In this theme most glass sits
// over live content -- track lists, the library grid, cards, text -- so instead
// of refracting what is behind them the panels render as flat dark album-art
// rectangles, and the app looks broken.
//
// For this to be usable, the set of surfaces migrated to GL has to be restricted
// to those whose backdrop genuinely is just the background (the now-playing bar
// and the Now Playing panel are the plausible candidates), with everything else
// staying on CSS backdrop-filter. That is a much smaller prize than the 27.9
// points the whole-scene version was aimed at.
//
// Enable with: window.liquifyGL.enable()

(function liquifyGlassGL() {
  const KEY = 'liquify-gl';
  if (!document.body) return setTimeout(liquifyGlassGL, 300);
  if (window.liquifyGL) return;

  // Surfaces whose backdrop is live DOM content rather than the background.
  const KEEP_CSS_GLASS = ['.main-trackList-trackListHeader', '.main-actionBar-ActionBar'];

  const GLASS_SELECTORS = [
    '.Root__now-playing-bar', '.main-nowPlayingView-headerWrapper', '.main-entityHeader-container',
    '.main-topBar-background', '.liquid-lyrics-control-pill', '.liquid-lyrics-sidebar-card',
    '.main-userWidget-box', '.view-homeShortcutsGrid-shortcut', '.main-home-filterChipsSection',
    '.liquid-lyrics-song-card', '.main-nowPlayingView-trackInfo', '.main-globalNav-historyButtons',
  ].join(',');

  const VERT = `#version 300 es
  in vec2 aPos;
  uniform vec4 uRect;      // x, y, w, h  (css px, top-left origin)
  uniform vec2 uRes;
  out vec2 vLocal;         // 0..1 within the quad
  out vec2 vScreen;        // 0..1 across the viewport
  void main() {
    vLocal = aPos;
    vec2 px = uRect.xy + aPos * uRect.zw;
    vScreen = px / uRes;
    vec2 clip = vec2(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0);
    gl_Position = vec4(clip, 0.0, 1.0);
  }`;

  // Background pass: the blurred album art, warped by the drift field.
  const FRAG_BG = `#version 300 es
  precision highp float;
  in vec2 vLocal; in vec2 vScreen;
  uniform sampler2D uBlur;
  uniform float uTime, uDriftAmp, uDriftFreq;
  uniform float uBrightness;
  out vec4 outColor;
  vec2 flow(vec2 p, float t) {
    // two rotating low-frequency waves -> smooth, non-repeating drift with no
    // visible centre of rotation
    float a = sin(p.x * uDriftFreq + t * 0.31) + cos(p.y * uDriftFreq * 1.3 - t * 0.21);
    float b = cos(p.x * uDriftFreq * 1.1 - t * 0.27) + sin(p.y * uDriftFreq * 0.9 + t * 0.19);
    return vec2(a, b);
  }
  void main() {
    vec2 uv = vScreen + flow(vScreen, uTime) * uDriftAmp;
    outColor = vec4(texture(uBlur, clamp(uv, 0.0, 1.0)).rgb * uBrightness, 1.0);
  }`;

  // Glass pass: one quad, one shader, everything inline.
  const FRAG_GLASS = `#version 300 es
  precision highp float;
  in vec2 vLocal; in vec2 vScreen;
  uniform sampler2D uBlur;
  uniform vec4 uRect;
  uniform vec2 uRes;
  uniform float uRadius, uTime, uDriftAmp, uDriftFreq;
  uniform float uRefract, uChroma, uTint, uSpec;
  out vec4 outColor;

  // signed distance to a rounded rectangle, in pixels
  float sdRoundRect(vec2 p, vec2 half_, float r) {
    vec2 q = abs(p) - half_ + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }
  vec2 flow(vec2 p, float t) {
    float a = sin(p.x * uDriftFreq + t * 0.31) + cos(p.y * uDriftFreq * 1.3 - t * 0.21);
    float b = cos(p.x * uDriftFreq * 1.1 - t * 0.27) + sin(p.y * uDriftFreq * 0.9 + t * 0.19);
    return vec2(a, b);
  }
  void main() {
    vec2 halfPx = uRect.zw * 0.5;
    vec2 p = (vLocal - 0.5) * uRect.zw;
    float d = sdRoundRect(p, halfPx, uRadius);
    if (d > 0.0) discard;                       // outside the rounded rect

    // surface normal from the SDF gradient: steep near the rim, flat in the
    // middle -- this is what makes the edge refract like a real bevel
    float e = 1.0;
    vec2 grad = vec2(
      sdRoundRect(p + vec2(e, 0.0), halfPx, uRadius) - sdRoundRect(p - vec2(e, 0.0), halfPx, uRadius),
      sdRoundRect(p + vec2(0.0, e), halfPx, uRadius) - sdRoundRect(p - vec2(0.0, e), halfPx, uRadius));
    grad /= (2.0 * e);

    // edge falloff: refraction concentrated in a rim a few px wide
    float rim = 1.0 - smoothstep(-24.0, 0.0, d);
    vec2 refr = grad * rim * uRefract / uRes;

    // drift costs nothing extra here: it rides the same dependent read
    vec2 base = vScreen + flow(vScreen, uTime) * uDriftAmp + refr;

    // chromatic dispersion = 3 taps, not 3 passes
    vec2 ca = grad * rim * uChroma / uRes;
    float r = texture(uBlur, clamp(base + ca, 0.0, 1.0)).r;
    float g = texture(uBlur, clamp(base,      0.0, 1.0)).g;
    float b = texture(uBlur, clamp(base - ca, 0.0, 1.0)).b;
    vec3 col = vec3(r, g, b);

    // specular sheen along the upper rim
    float spec = pow(max(0.0, -grad.y) * rim, 2.0) * uSpec;
    col += spec;
    col = mix(col, vec3(1.0), uTint * rim * 0.10);

    float aa = clamp(-d, 0.0, 1.0);             // antialiased edge
    outColor = vec4(col, aa);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  }

  const state = {
    canvas: null, gl: null, progBg: null, progGlass: null, vao: null,
    blurTex: null, rects: [], raf: 0, running: false, art: null, lastArt: '',
    fps: 0, frames: 0, lastFpsT: 0,
  };

  function ensureCanvas() {
    if (state.canvas) return state.canvas;
    const c = document.createElement('canvas');
    c.id = 'liquify-gl-canvas';
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:0';
    const host = document.querySelector('.Root__top-container') || document.body;
    host.insertBefore(c, host.firstChild);
    state.canvas = c;
    return c;
  }

  function initGL() {
    const c = ensureCanvas();
    const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    state.gl = gl;
    state.progBg = program(gl, VERT, FRAG_BG);
    state.progGlass = program(gl, VERT, FRAG_GLASS);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    state.vao = vao;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // The album art, downsampled and blurred ONCE on a 2D canvas, uploaded as the
  // single texture every surface samples. This is the "one shared blur".
  async function loadArt(url) {
    if (!url || url === state.lastArt) return;
    state.lastArt = url;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const W = 256, H = 256;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.drawImage(img, 0, 0, W, H);
    x.filter = 'blur(18px)';
    x.drawImage(cv, 0, 0);
    x.filter = 'none';
    const gl = state.gl;
    if (!state.blurTex) state.blurTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.blurTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function currentArtUrl() {
    const el = document.querySelector('.liquify-bg-layer');
    const m = el && getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)/);
    return m ? m[1] : null;
  }

  // Rects are read on mutation/resize/scroll, never per frame -- reading
  // getBoundingClientRect for ~90 elements every frame would reintroduce exactly
  // the layout thrash this is meant to remove.
  function collectRects() {
    const out = [];
    for (const el of document.querySelectorAll(GLASS_SELECTORS)) {
      if (KEEP_CSS_GLASS.some(s => el.matches(s))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      const radius = parseFloat(cs.borderTopLeftRadius) || 12;
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, r: Math.min(radius, Math.min(r.width, r.height) / 2) });
    }
    state.rects = out;
  }

  function resize() {
    const c = state.canvas, gl = state.gl;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
  }

  function frame(t) {
    if (!state.running) return;
    const gl = state.gl;
    resize();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(state.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.blurTex);

    const cfg = window.liquifyDrift ? window.liquifyDrift.get() : { strength: 55, speed: 65 };
    const driftAmp = (cfg.strength / 100) * 0.05;
    const driftFreq = 3.0;
    const time = t / 1000;
    const res = [innerWidth, innerHeight];

    if (state.blurTex) {
      gl.useProgram(state.progBg);
      gl.uniform4f(gl.getUniformLocation(state.progBg, 'uRect'), 0, 0, res[0], res[1]);
      gl.uniform2f(gl.getUniformLocation(state.progBg, 'uRes'), res[0], res[1]);
      gl.uniform1i(gl.getUniformLocation(state.progBg, 'uBlur'), 0);
      gl.uniform1f(gl.getUniformLocation(state.progBg, 'uTime'), time);
      gl.uniform1f(gl.getUniformLocation(state.progBg, 'uDriftAmp'), driftAmp);
      gl.uniform1f(gl.getUniformLocation(state.progBg, 'uDriftFreq'), driftFreq);
      gl.uniform1f(gl.getUniformLocation(state.progBg, 'uBrightness'), 0.45);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const P = state.progGlass;
      gl.useProgram(P);
      gl.uniform2f(gl.getUniformLocation(P, 'uRes'), res[0], res[1]);
      gl.uniform1i(gl.getUniformLocation(P, 'uBlur'), 0);
      gl.uniform1f(gl.getUniformLocation(P, 'uTime'), time);
      gl.uniform1f(gl.getUniformLocation(P, 'uDriftAmp'), driftAmp);
      gl.uniform1f(gl.getUniformLocation(P, 'uDriftFreq'), driftFreq);
      gl.uniform1f(gl.getUniformLocation(P, 'uRefract'), 90.0);
      gl.uniform1f(gl.getUniformLocation(P, 'uChroma'), 14.0);
      gl.uniform1f(gl.getUniformLocation(P, 'uTint'), 1.0);
      gl.uniform1f(gl.getUniformLocation(P, 'uSpec'), 0.10);
      const uRect = gl.getUniformLocation(P, 'uRect');
      const uRad = gl.getUniformLocation(P, 'uRadius');
      for (const q of state.rects) {
        gl.uniform4f(uRect, q.x, q.y, q.w, q.h);
        gl.uniform1f(uRad, q.r);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    state.frames++;
    if (t - state.lastFpsT > 1000) { state.fps = state.frames * 1000 / (t - state.lastFpsT); state.frames = 0; state.lastFpsT = t; }
    state.raf = requestAnimationFrame(frame);
  }

  // While GL is running, the CSS glass and CSS background must be turned off or
  // we pay for both.
  const suppress = document.createElement('style');
  suppress.id = 'liquify-gl-suppress';
  suppress.textContent = `
    html.liquify-gl :is(${GLASS_SELECTORS}) {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      background-color: transparent !important;
    }
    html.liquify-gl .liquify-bg-layer { filter: none !important; opacity: 0 !important; }`;
  document.head.appendChild(suppress);

  let scheduled = false;
  const scheduleRects = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (state.running) collectRects(); });
  };

  async function enable() {
    if (state.running) return 'already running';
    if (!state.gl) initGL();
    await loadArt(currentArtUrl());
    document.documentElement.classList.add('liquify-gl');
    collectRects();
    state.running = true;
    state.lastFpsT = performance.now();
    state.raf = requestAnimationFrame(frame);
    addEventListener('resize', scheduleRects, { passive: true });
    addEventListener('scroll', scheduleRects, { passive: true, capture: true });
    state._obs = new MutationObserver(scheduleRects);
    state._obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    try { Spicetify?.Player?.addEventListener?.('songchange', () => loadArt(currentArtUrl())); } catch {}
    localStorage.setItem(KEY, 'on');
    return 'enabled';
  }

  function disable() {
    state.running = false;
    cancelAnimationFrame(state.raf);
    state._obs?.disconnect();
    removeEventListener('resize', scheduleRects);
    removeEventListener('scroll', scheduleRects, true);
    document.documentElement.classList.remove('liquify-gl');
    localStorage.setItem(KEY, 'off');
    return 'disabled';
  }

  window.liquifyGL = {
    enable, disable, state,
    get fps() { return +state.fps.toFixed(1); },
    get quads() { return state.rects.length; },
  };
  if (localStorage.getItem(KEY) === 'on') enable().catch(e => console.error('liquify-gl', e));
})();
