// liquify-fabric-bg — the album art itself, warped continuously, as the background.
//
// APPROACH, and the two dead ends that led here:
//
//   1. An SVG `feDisplacementMap` over the existing background layer. Measured
//      80 GPU points with `feTurbulence` as the map (procedural noise is
//      re-synthesised per pixel per frame), and with a pre-rasterised map the
//      warp changed the mean pixel value by 1.3% -- invisible, because the layer
//      it deformed was already downscaled, blurred and dimmed. Post-processing
//      the render was the wrong level to work at.
//
//   2. Deforming the texture through a triangle mesh in Canvas 2D. This did
//      warp the image, but a mesh is piecewise-linear BY CONSTRUCTION: each
//      triangle gets its own affine map, so the deformation is only C0 across
//      the seams and every strong pull shows as a hard crease. Denser meshes and
//      smoother fields only shrink the creases, and blurring merely hides them.
//
// The deformation has to be a continuous function evaluated per pixel, which
// means a fragment shader. `i.scdn.co` serves the covers with CORS headers, so
// the art can be uploaded as a texture (verified) -- and `MIRRORED_REPEAT`
// handles sampling outside the image for free, so the sheet can be hauled as far
// as we like without ever running out of picture.
//
// Cost: the shader is trivial and runs on a fifth-resolution canvas. What
// actually costs anything is that a changing backdrop forces every
// `backdrop-filter` surface above it to recompose, so the frame rate -- not the
// shader -- is the dial that matters.

(function liquifyFabricBg() {
  if (!window.Spicetify?.Player?.data || !document.body) return setTimeout(liquifyFabricBg, 400);

  const STRENGTH_KEY = 'liquify-drift-strength';   // "Distortion" in the panel
  const SPEED_KEY = 'liquify-drift-speed';         // "Motion speed"
  const BLUR_KEY = 'liquify-fabric-blur';          // "Blur"
  const FPS_KEY = 'liquify-fabric-fps';            // "Frame rate"
  const num = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; };
  const cfg = () => ({
    strength: Math.max(0, Math.min(100, num(STRENGTH_KEY, 70))),
    speed: Math.max(1, Math.min(100, num(SPEED_KEY, 45))),
    blur: Math.max(0, Math.min(160, num(BLUR_KEY, 38))),
    fps: Math.max(10, Math.min(60, num(FPS_KEY, 60))),
  });

  // 1/4 viewport. Lower than this and the blur has too little structure left to
  // work with -- at 1/6 with a 70px blur the frame went to flat black with a
  // faint glow, which is not "unreadable", it is "gone".
  const RES = 4;
  const GRIPS = 3;

  // Sampling headroom. The warp pushes texture coordinates outside 0..1, and
  // what happens there is the whole question. MIRRORED_REPEAT reflects the
  // cover, which reads as an obvious tile -- that was the "it just looks like
  // the image tiled" problem. Zooming hard into the middle avoids ever reaching
  // the edge but magnifies the art past recognition.
  //
  // So: no zoom at all -- a plain cover fit, the cover at its natural framing --
  // and CLAMP_TO_EDGE for whatever the pull drags past the border. Clamping
  // smears the edge pixel outward instead of reflecting a copy of the picture,
  // and under this much blur that smear is indistinguishable from the image
  // simply continuing, whereas a mirrored tile stays recognisable however
  // blurred it gets.
  const ZOOM = 1.0;

  const canvas = document.createElement('canvas');
  canvas.id = 'lqx-fabric';
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false });
  if (!gl) { console.warn('[liquify-fabric-bg] no webgl2; leaving the stock background alone'); return; }

  const style = document.createElement('style');
  style.id = 'lqx-fabric-style';
  document.head.appendChild(style);
  // NOTE: the canvas element is laid out at the full viewport size (its backing
  // store is smaller and upscaled), and a CSS filter operates on the element's
  // rendered box -- so this radius is already in screen pixels. An earlier
  // version divided it by RES and wondered why nothing looked blurred.
  let lastBlur = -1;
  function applyBlur(px) {
    if (px === lastBlur) return;
    lastBlur = px;
    style.textContent = `
      #lqx-fabric{position:fixed;inset:0;width:100%;height:100%;z-index:0;
        pointer-events:none;filter:blur(${px.toFixed(1)}px) brightness(.45)}
      html.lqx-fabric-on .liquify-bg-layer{display:none!important}
      html.liquify-perf #lqx-fabric{filter:blur(${(px / 2).toFixed(1)}px) brightness(.45)}`;
  }

  // ---- shader ----
  const VS = `#version 300 es
  const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
  out vec2 vUv;
  void main(){ vec2 p = P[gl_VertexID]; vUv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uA, uB;
  uniform float uMix, uT, uAmp;
  uniform vec2 uCover;
  uniform float uZoom;
  uniform vec2 uMean;             // frame-average pull, subtracted below
  uniform vec4 uGrip[${GRIPS}];   // xy = grip point, zw = pull direction
  uniform vec2 uGW[${GRIPS}];     // x = weight, y = reach

  // One smooth function of position, evaluated per pixel. Every term is C-infinity:
  // a Gaussian has no cutoff ridge and no singularity at its centre, so there is
  // no place in the frame where the deformation can kink.
  vec2 pull(vec2 p){
    vec2 d = vec2(0.);
    for (int i=0;i<${GRIPS};i++){
      vec2 q = p - uGrip[i].xy;
      d += uGrip[i].zw * exp(-dot(q,q)/(uGW[i].y*uGW[i].y)*2.2) * uGW[i].x;
    }
    // a slow whole-sheet swell so nothing is ever completely still
    d += 0.18*vec2(sin(p.y*2.3 + uT*0.21), cos(p.x*1.9 - uT*0.17));
    // and a second, even lower-frequency term on a different period
    d += 0.12*vec2(cos(p.x*1.3 - uT*0.13), sin(p.y*1.1 + uT*0.11));
    return d*uAmp;
  }

  void main(){
    // Subtracting the frame average makes the field mean-zero, i.e. pure
    // stretch with no net translation. Without this the summed directional
    // pulls drag the whole frame off the texture, everything outside gets
    // clamp-filled with the edge pixel, and the result is a flat smear with no
    // composition left -- which is precisely how the first version looked.
    vec2 uv = vUv + (pull(vUv) - uMean);
    vec2 t = (uv-0.5)*uCover*uZoom + 0.5;   // cover-fit, zoomed in for headroom
    outColor = mix(texture(uA,t), texture(uB,t), uMix);
  }`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  // Everything below -- the program, the uniform locations, the textures and
  // every scrap of pixel-store state -- is owned by the GL context, and a
  // context loss destroys all of it. That is not a rare condition: hiding and
  // reopening the window is enough. So it lives in one function that can simply
  // be run again.
  let prog, uni, texA, texB;

  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // see the ZOOM note: clamping smears, mirroring tiles, and a smear hides
    // under the blur while a tile does not
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    return t;
  };

  function initGL() {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[liquify-fabric-bg]', gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);
    const U = (n) => gl.getUniformLocation(prog, n);
    uni = { A: U('uA'), B: U('uB'), mix: U('uMix'), t: U('uT'), amp: U('uAmp'),
            cover: U('uCover'), zoom: U('uZoom'), mean: U('uMean'),
            grip: U('uGrip'), gw: U('uGW') };
    gl.uniform1i(uni.A, 0);
    gl.uniform1i(uni.B, 1);
    texA = mkTex();
    texB = mkTex();
    return true;
  }
  if (!initGL()) return;

  // A restore hands back a context reset to defaults -- and the default for
  // UNPACK_FLIP_Y_WEBGL is false, which is exactly how the cover came back
  // upside down after reopening the window. Worse, a context is only ever
  // restored if the loss event is preventDefault-ed; without that the canvas
  // stays dead for the rest of the session.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    running = false;
    console.warn('[liquify-fabric-bg] webgl context lost; awaiting restore');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (!initGL()) return;
    haveArt = false; lastUrl = ''; mixv = 0; fadeTo = 0; toB = true;
    lastBlur = -1;
    refreshArt();
    apply();
    console.log('[liquify-fabric-bg] webgl context restored');
  });

  let mixv = 0, haveArt = false;

  // ---- artwork ----
  const artUrl = () => {
    const m = Spicetify.Player.data?.item?.metadata || {};
    const raw = m.image_xlarge_url || m.image_large_url || m.image_url || '';
    return raw.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + raw.slice(14) : raw;
  };
  let lastUrl = '', toB = true;
  async function refreshArt() {
    const url = artUrl();
    if (!url || url === lastUrl) return;
    lastUrl = url;
    const img = await new Promise((r) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';       // i.scdn.co sends CORS headers
      i.onload = () => r(i); i.onerror = () => r(null);
      i.src = url;
    });
    if (!img) return;
    // Set immediately before the upload rather than once at startup: this is
    // context state, and a context loss silently returns it to false.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const target = toB ? texB : texA;
    gl.activeTexture(toB ? gl.TEXTURE1 : gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    if (!haveArt) {                       // first track: fill both, no crossfade
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      mixv = toB ? 1 : 0; haveArt = true;
    }
    fadeTo = toB ? 1 : 0;
    toB = !toB;
  }
  let fadeTo = 0;
  Spicetify.Player.addEventListener('songchange', refreshArt);
  refreshArt();

  // ---- grips ----
  //
  // Each grip ramps its pull up, holds, releases to zero, and only then takes a
  // new hold somewhere else on the border -- so the pull points keep changing
  // and nothing ever snaps, because a grip is always weightless when it moves.
  const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
  function newGrip() {
    const s = Math.floor(Math.random() * 4), t = 0.05 + Math.random() * 0.9;
    const pos = s === 0 ? [t, 0] : s === 1 ? [1, t] : s === 2 ? [t, 1] : [0, t];
    const out = s === 0 ? [0, -1] : s === 1 ? [1, 0] : s === 2 ? [0, 1] : [-1, 0];
    const a = (Math.random() - 0.5) * 1.8;               // up to ~50deg off normal
    return { pos,
      dir: [out[0] * Math.cos(a) - out[1] * Math.sin(a), out[0] * Math.sin(a) + out[1] * Math.cos(a)],
      reach: 0.8 + Math.random() * 0.8, gain: 0.85 + Math.random() * 0.6 };
  }
  const grips = [];
  for (let i = 0; i < GRIPS; i++) grips.push({ period: 46 + i * 19, phase: Math.random(), cycle: -1, ...newGrip() });

  function gripUniforms(tSec) {
    const g = new Float32Array(GRIPS * 4), w = new Float32Array(GRIPS * 2);
    grips.forEach((a, i) => {
      const k = tSec / a.period + a.phase, cyc = Math.floor(k);
      if (cyc !== a.cycle) { a.cycle = cyc; Object.assign(a, newGrip()); }
      const u = k - cyc;
      const env = u < 0.32 ? smooth(u / 0.32) : u < 0.62 ? 1 : smooth(1 - (u - 0.62) / 0.38);
      g[i * 4] = a.pos[0]; g[i * 4 + 1] = a.pos[1]; g[i * 4 + 2] = a.dir[0]; g[i * 4 + 3] = a.dir[1];
      w[i * 2] = env * a.gain; w[i * 2 + 1] = a.reach;
    });
    return [g, w];
  }

  // Mirrors the shader's pull() so the frame average can be subtracted. Kept
  // deliberately adjacent to the GLSL above: if one changes, so must the other.
  function pullAt(px, py, g, w, t, amp) {
    let dx = 0, dy = 0;
    for (let i = 0; i < GRIPS; i++) {
      const qx = px - g[i * 4], qy = py - g[i * 4 + 1];
      const r = w[i * 2 + 1];
      const k = Math.exp(-((qx * qx + qy * qy) / (r * r)) * 2.2) * w[i * 2];
      dx += g[i * 4 + 2] * k; dy += g[i * 4 + 3] * k;
    }
    dx += 0.18 * Math.sin(py * 2.3 + t * 0.21);
    dy += 0.18 * Math.cos(px * 1.9 - t * 0.17);
    dx += 0.12 * Math.cos(px * 1.3 - t * 0.13);
    dy += 0.12 * Math.sin(py * 1.1 + t * 0.11);
    return [dx * amp, dy * amp];
  }
  function meanPull(g, w, t, amp) {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const [dx, dy] = pullAt(i / 8, j / 8, g, w, t, amp);
        sx += dx; sy += dy; n++;
      }
    }
    return [sx / n, sy / n];
  }

  // ---- loop ----
  let last = 0, running = false;
  function resize() {
    const w = Math.max(160, Math.round(window.innerWidth / RES));
    const h = Math.max(120, Math.round(window.innerHeight / RES));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener('resize', resize);

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const { strength, speed, blur, fps } = cfg();
    if (document.hidden || strength <= 0 || !haveArt) return;
    if (now - last < 1000 / fps) return;
    last = now;
    resize();
    applyBlur(blur);
    // Time base. At the default this puts a grip cycle around two minutes and
    // the background swell around 75s -- slow enough that you never catch it
    // moving, fast enough that the frame is visibly different if you look away
    // and back. 0.30 here was 15x too slow: a grip took 12 minutes to complete.
    const t = now / 1000 * (speed / 100) * 0.9;
    const [g, w] = gripUniforms(t);
    const A = canvas.width / canvas.height;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
    mixv += Math.max(-1, Math.min(1, fadeTo - mixv)) * 0.06;   // crossfade on track change
    gl.uniform1f(uni.mix, mixv);
    gl.uniform1f(uni.t, t);
    const amp = (strength / 100) * 0.55;
    gl.uniform1f(uni.amp, amp);
    const [mx, my] = meanPull(g, w, t, amp);
    gl.uniform2f(uni.mean, mx, my);
    gl.uniform2f(uni.cover, 1, 1 / A);
    gl.uniform1f(uni.zoom, ZOOM);
    gl.uniform4fv(uni.grip, g);
    gl.uniform2fv(uni.gw, w);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const mount = () => {
    const layer = [...document.querySelectorAll('.liquify-bg-layer')].pop();
    const parent = layer?.parentElement || document.querySelector('.Root__top-container');
    if (!parent) return false;
    if (canvas.parentElement !== parent) parent.insertBefore(canvas, parent.firstChild);
    return true;
  };
  function apply() {
    const on = cfg().strength > 0;
    document.documentElement.classList.toggle('lqx-fabric-on', on);
    canvas.style.display = on ? '' : 'none';
    if (on && !running) { running = true; resize(); requestAnimationFrame(frame); }
    if (!on) running = false;
  }
  const boot = () => { if (!mount()) return setTimeout(boot, 600); resize(); applyBlur(cfg().blur); apply(); };
  boot();
  setInterval(() => { mount(); apply(); }, 2000);

  window.liquifyFabric = {
    canvas, cfg,
    set: (o = {}) => {
      const map = { strength: STRENGTH_KEY, speed: SPEED_KEY, blur: BLUR_KEY, fps: FPS_KEY };
      for (const k of Object.keys(map)) if (o[k] != null) localStorage.setItem(map[k], String(o[k]));
      apply(); return cfg();
    },
  };
  console.log('[liquify-fabric-bg] per-pixel warp active');
})();
