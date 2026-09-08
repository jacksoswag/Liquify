// liquify-glass-gl — WebGL album background with evolving drift.
//
// WHAT THIS REPLACES
//   * .liquify-bg-layer  -- 2 full-viewport CSS `filter: blur() brightness()` layers  (~4.4 GPU pts)
//   * the SVG drift chain -- feImage -> feOffset -> feDisplacementMap, re-run every frame (~21 GPU pts)
//
// WHY THIS ONE WORKS AND THE GLASS VERSION DID NOT
//   A WebGL canvas cannot sample DOM pixels. That killed the attempt to move the
//   GLASS PANELS onto the GPU: most of this theme's glass sits over live content
//   (track lists, the library grid), so the panels could only refract the album
//   art and rendered as flat dark rectangles.
//
//   The BACKGROUND has no such problem -- nothing is behind it, it IS the bottom
//   layer. And because a <canvas> is ordinary painted page content, every CSS
//   `backdrop-filter` above it samples it exactly as it sampled the old div. So
//   the glass keeps working untouched, refracting both this canvas and the DOM
//   content above it, while the two things that were genuinely expensive --
//   a live full-viewport CSS blur, and a per-frame SVG displacement graph --
//   collapse into one shader that costs a single fullscreen pass.
//
//   Drift is nearly free to PRODUCE here: two sin/cos pairs perturbing the
//   texture coordinate of a read the shader already performs, instead of a
//   filter graph re-evaluated every frame at device resolution.
//
// RESULT: functionally correct, but NO measurable performance gain. Off by
// default. Two independent paired runs, 6 interleaved cycles each:
//
//     GL + drift 60 .... 75.9%      GL idle (drift 0) .... 70.4%
//     CSS + drift 60 ... 71.6%      CSS (drift 0) ........ 70.4%
//     CSS drift 0 ...... 69.4%      GL + drift 60 ........ 71.6%
//     GL drift 0 ....... 72.0%      CSS + drift 60 ....... 70.5%
//
// Why it does not help, and this is the useful part: the expensive thing was
// never PRODUCING the background. It is that a background which changes every
// frame invalidates all ~89 `backdrop-filter` surfaces stacked above it, and
// every one of them must recompute. Moving the background onto the GPU makes
// the background cheap and leaves that invalidation completely untouched.
//
// So the consolidation only ever paid off if the GLASS moved to the GPU too --
// and it cannot, because a WebGL canvas cannot sample DOM pixels, so panels
// sitting over track lists and grids would refract only the album art. Both
// halves of the idea fail for the same underlying reason, from opposite sides.
//
// What did survive: when drift is 0 the output is static, so the render loop
// now stops entirely (`state.idle`) rather than redrawing an unchanging image
// behind 89 filters.

(function liquifyGlassGL() {
  const KEY = 'liquify-gl';
  if (!document.body) return setTimeout(liquifyGlassGL, 300);
  if (window.liquifyGL) return;

  const VERT = `#version 300 es
  in vec2 aPos;
  out vec2 vUV;
  void main() {
    vUV = aPos;
    gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec2 vUV;
  uniform sampler2D uArt;
  uniform float uTime, uAmp, uFreq, uBrightness;
  uniform vec2 uCover;          // aspect correction so the art fills like background-size:cover
  out vec4 outColor;

  // Two low-frequency wave pairs at incommensurate rates. No rotation, so there
  // is no visible swirl centre -- the field just breathes and slides, and the
  // periods never line up, so it does not visibly loop.
  vec2 flow(vec2 p, float t) {
    float a = sin(p.x * uFreq + t * 0.31) + cos(p.y * uFreq * 1.30 - t * 0.21);
    float b = cos(p.x * uFreq * 1.13 - t * 0.27) + sin(p.y * uFreq * 0.91 + t * 0.19);
    return vec2(a, b);
  }
  void main() {
    vec2 uv = (vUV - 0.5) * uCover + 0.5;
    uv += flow(vUV, uTime) * uAmp;
    // flip Y: canvas texture origin is bottom-left, page origin is top-left
    vec3 c = texture(uArt, vec2(clamp(uv.x, 0.0, 1.0), clamp(1.0 - uv.y, 0.0, 1.0))).rgb;
    outColor = vec4(c * uBrightness, 1.0);
  }`;

  const S = { canvas: null, gl: null, prog: null, vao: null, tex: null,
              raf: 0, running: false, lastArt: '', frames: 0, fpsT: 0, fps: 0, u: {} };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }

  // Anchored separately from initGL: the extension loads before Liquify builds
  // its background layers, so placement has to be re-attempted until they exist.
  function placeCanvas() {
    const c = S.canvas;
    if (!c) return false;
    const layers = document.querySelectorAll('.liquify-bg-layer');
    const ref = layers[layers.length - 1];
    if (ref && ref.parentElement) {
      if (c.previousElementSibling !== ref) ref.after(c);
      return true;
    }
    const top = document.querySelector('.Root__top-container');
    if (top) { if (c.parentElement !== top) top.prepend(c); return false; }
    if (c.parentElement !== document.body) document.body.prepend(c);
    return false;
  }

  function initGL() {
    const c = document.createElement('canvas');
    c.id = 'liquify-gl-canvas';
    // sits exactly where .liquify-bg-layer sat: fixed, full viewport, behind
    // everything, and non-interactive
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:0';
    // Paint order matters: Liquify ships a crossfade PAIR (.liquify-bg-layer
    // layer-a / layer-b) plus .liquify-animated-bg and .liquify-kawarp-bg, all
    // position:fixed at z-index 0 in .Root__top-container. Equal z-index means
    // DOM order decides, so inserting BEFORE them leaves the canvas painted
    // under later opaque siblings and it renders as a black screen. It must go
    // after the LAST background layer.
    S.canvas = c;
    placeCanvas();

    const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    S.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    S.prog = p;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    S.vao = vao;
    for (const n of ['uArt','uTime','uAmp','uFreq','uBrightness','uCover'])
      S.u[n] = gl.getUniformLocation(p, n);
  }

  // The blur is done ONCE per track on a 2D canvas and uploaded as a texture.
  // Nothing re-blurs per frame -- that was the whole point.
  async function loadArt(url) {
    if (!url || url === S.lastArt || !S.gl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    } catch { return; }
    S.lastArt = url;
    const N = 384;
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const x = cv.getContext('2d');
    x.drawImage(img, 0, 0, N, N);
    const out = document.createElement('canvas'); out.width = out.height = N;
    const ox = out.getContext('2d');
    ox.filter = 'blur(7px)';   // matches the CSS layer's effective radius; 16px on a small texture flattens it to near-uniform grey
    ox.drawImage(cv, 0, 0);
    ox.filter = 'none';
    const gl = S.gl;
    if (!S.tex) S.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, S.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  const artUrl = () => {
    for (const sel of ['.liquify-bg-layer', '.liquify-animated-tile']) {
      const el = document.querySelector(sel);
      const m = el && getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)/);
      if (m) return m[1];
    }
    try { return Spicetify?.Player?.data?.item?.metadata?.image_xlarge_url?.replace('spotify:image:', 'https://i.scdn.co/image/') || null; }
    catch { return null; }
  };

  function frame(t) {
    if (!S.running) return;
    const gl = S.gl, c = S.canvas;
    // Render at a fraction of device resolution. The output is a heavy blur, so
    // the upscale is free visually and quarters the fill cost.
    const scale = 0.5;
    const w = Math.max(2, Math.round(innerWidth * scale)), h = Math.max(2, Math.round(innerHeight * scale));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; gl.viewport(0, 0, w, h); }

    if (S.tex) {
      const cfg = window.liquifyDrift ? window.liquifyDrift.get() : { strength: 55, speed: 65 };
      const amp = (cfg.strength / 100) * 0.045;
      S.staticFrame = amp === 0;
      const speed = 0.25 + (cfg.speed / 100) * 1.2;
      const ar = innerWidth / innerHeight;
      const cover = ar > 1 ? [1, 1 / ar] : [ar, 1];
      gl.useProgram(S.prog);
      gl.bindVertexArray(S.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, S.tex);
      gl.uniform1i(S.u.uArt, 0);
      gl.uniform1f(S.u.uTime, (t / 1000) * speed);
      gl.uniform1f(S.u.uAmp, amp);
      gl.uniform1f(S.u.uFreq, 2.6);
      gl.uniform1f(S.u.uBrightness, 0.55);
      gl.uniform2f(S.u.uCover, cover[0], cover[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    S.frames++;
    if (t - S.fpsT > 1000) { S.fps = S.frames * 1000 / (t - S.fpsT); S.frames = 0; S.fpsT = t; }

    // With drift at 0 the output is a STATIC image, so redrawing it every frame
    // is pure waste -- and worse than waste: this canvas sits behind ~89
    // backdrop-filter surfaces, and any change to it forces every one of them to
    // recompute. Draw once, then idle until something actually changes.
    if (S.staticFrame) { S.idle = true; return; }
    S.raf = requestAnimationFrame(frame);
  }

  // With GL on, the CSS background layers must stop painting or we pay twice.
  const suppress = document.createElement('style');
  suppress.id = 'liquify-gl-suppress';
  suppress.textContent = `
    html.liquify-gl .liquify-bg-layer,
    html.liquify-gl .liquify-kawarp-bg,
    html.liquify-gl .liquify-animated-bg { display: none !important; }`;
  document.head.appendChild(suppress);

  async function enable() {
    if (S.running) return 'already running';
    if (!S.gl) initGL();
    if (!placeCanvas()) return 'background layers not ready';
    await loadArt(artUrl());
    if (!S.tex) return 'no album art texture';
    document.documentElement.classList.add('liquify-gl');
    S.running = true; S.fpsT = performance.now();
    S.raf = requestAnimationFrame(frame);
    try { Spicetify?.Player?.addEventListener?.('songchange', () => loadArt(artUrl())); } catch {}
    S.poll = setInterval(() => { placeCanvas(); loadArt(artUrl()); if (S.idle) wake(); }, 4000);
    addEventListener('resize', wake, { passive: true });
    localStorage.setItem(KEY, 'on');
    return 'enabled';
  }

  function wake() {
    if (!S.running) return;
    S.idle = false; S.staticFrame = false;
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(frame);
  }

  function disable() {
    S.running = false;
    cancelAnimationFrame(S.raf);
    clearInterval(S.poll);
    document.documentElement.classList.remove('liquify-gl');
    localStorage.setItem(KEY, 'off');
    return 'disabled';
  }

  window.liquifyGL = {
    enable, disable, wake, state: S,
    get idle() { return !!S.idle; },
    reloadArt() { S.lastArt = ''; return loadArt(artUrl()); },
    get fps() { return +S.fps.toFixed(1); },
    get hasTexture() { return !!S.tex; },
  };
  // The extension loads before Liquify has built its background layers, so the
  // first enable() finds no art and bails. Retry until it takes.
  if (localStorage.getItem(KEY) === 'on') {
    let tries = 0;
    const boot = setInterval(async () => {
      if (S.running || ++tries > 40) return clearInterval(boot);
      try { if ((await enable()) === 'enabled') clearInterval(boot); } catch {}
    }, 700);
  }
})();
