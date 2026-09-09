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

  const STRENGTH_KEY = 'liquify-drift-strength';   // shared with Liquify's sliders
  const SPEED_KEY = 'liquify-drift-speed';
  const num = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return Number.isFinite(v) ? v : d; };
  const cfg = () => ({
    strength: Math.max(0, Math.min(100, num(STRENGTH_KEY, 65))),
    speed: Math.max(1, Math.min(100, num(SPEED_KEY, 65))),
  });

  const RES = 5;      // render at 1/5 viewport; the result is unreadable anyway
  const BLUR = 26;    // effective blur in screen pixels
  const FPS = 12;     // the real cost dial -- see the note above
  const GRIPS = 3;

  const canvas = document.createElement('canvas');
  canvas.id = 'lqx-fabric';
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false });
  if (!gl) { console.warn('[liquify-fabric-bg] no webgl2; leaving the stock background alone'); return; }

  const style = document.createElement('style');
  style.id = 'lqx-fabric-style';
  style.textContent = `
    #lqx-fabric{position:fixed;inset:0;width:100%;height:100%;z-index:0;
      pointer-events:none;filter:blur(${(BLUR / RES).toFixed(2)}px) brightness(.45)}
    html.lqx-fabric-on .liquify-bg-layer{display:none!important}
    html.liquify-perf #lqx-fabric{filter:blur(${(BLUR / RES / 2).toFixed(2)}px) brightness(.45)}`;
  document.head.appendChild(style);

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
    vec2 uv = vUv + pull(vUv);
    vec2 t = (uv-0.5)*uCover + 0.5;   // cover-fit the square cover to the frame
    outColor = mix(texture(uA,t), texture(uB,t), uMix);
  }`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = { A: U('uA'), B: U('uB'), mix: U('uMix'), t: U('uT'), amp: U('uAmp'),
                cover: U('uCover'), grip: U('uGrip'), gw: U('uGW') };
  gl.uniform1i(uni.A, 0); gl.uniform1i(uni.B, 1);

  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // MIRRORED_REPEAT is what lets the sheet be pulled past its own edges: the
    // image reflects at each border, which joins seamlessly.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    return t;
  };
  const texA = mkTex(), texB = mkTex();
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
    const { strength, speed } = cfg();
    if (document.hidden || strength <= 0 || !haveArt) return;
    if (now - last < 1000 / FPS) return;
    last = now;
    resize();
    const t = now / 1000 * (speed / 65);
    const [g, w] = gripUniforms(t);
    const A = canvas.width / canvas.height;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
    mixv += Math.max(-1, Math.min(1, fadeTo - mixv)) * 0.06;   // crossfade on track change
    gl.uniform1f(uni.mix, mixv);
    gl.uniform1f(uni.t, t);
    gl.uniform1f(uni.amp, (strength / 100) * 0.85);
    gl.uniform2f(uni.cover, 1, 1 / A);
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
  const boot = () => { if (!mount()) return setTimeout(boot, 600); resize(); apply(); };
  boot();
  setInterval(() => { mount(); apply(); }, 2000);

  window.liquifyFabric = {
    canvas, cfg,
    set: (strength, speed) => {
      if (strength != null) localStorage.setItem(STRENGTH_KEY, String(strength));
      if (speed != null) localStorage.setItem(SPEED_KEY, String(speed));
      apply(); return cfg();
    },
  };
  console.log('[liquify-fabric-bg] per-pixel warp active');
})();
