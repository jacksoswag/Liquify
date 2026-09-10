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
    // 12, and the number matters more than it looks. This blur is what the
    // theme's glass has to refract: every panel carries
    // `backdrop-filter: url(#lqx-lo) blur(2px)`, a 2px blur plus an SVG
    // displacement map, and both of those are transformations of DETAIL. Blur
    // this layer to mush first and there is nothing left for them to bend --
    // the panels go flat, and the glass looks broken while being perfectly
    // functional. Measured with a probe: at 30 the difference between a glass
    // panel and a plain tinted box was invisible; at 12 the album art reads
    // through every panel edge. The old default of 38 was chosen for how the
    // background alone looked, which was the wrong thing to be looking at.
    blur: Math.max(0, Math.min(160, num(BLUR_KEY, 12))),
    fps: Math.max(4, Math.min(60, num(FPS_KEY, 60))),
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

  // How far the background is dimmed. Named because TWO passes need it now: the
  // CSS filter on the background canvas, and the glass pass, which has to sit a
  // known amount brighter than the wall it is set into rather than at some
  // number that happened to look right once.
  const DIM = 0.45;

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
  //
  // And that is exactly why the element has to be BIGGER than the viewport. A
  // CSS blur is a convolution against the element's OWN rendering, and outside
  // the element there is nothing to convolve with, so a canvas laid out at
  // inset:0 fades to transparent over roughly 3 sigma at all four edges of the
  // screen. Nothing covers those edges except the strips of background between
  // the panels -- which is the only background there is to look at. Measured at
  // the default 12px blur, screenshotting the running client: the left gap and
  // the bottom strip came back at luminance 53 and 17 against 91 for the same
  // wall a few pixels further in. A 40-80% darkening, running around the whole
  // frame, on the one part of the background that is visible.
  //
  // So the element runs past the viewport far enough that the fade happens
  // off-screen. The BACKING STORE grows with it -- the shader's cover fit is
  // computed from the canvas aspect ratio, so growing the box alone would
  // stretch the art. 2.5 sigma leaves ~1% of the Gaussian outside; at the
  // default blur that is 38px a side, and at quarter resolution it costs 10
  // extra pixels of width.
  const OVER = (px) => Math.ceil(Math.max(0, px) * 2.5) + 8;
  let lastBlur = -1;
  function applyBlur(px) {
    if (px === lastBlur) return;
    lastBlur = px;
    const o = OVER(px);
    // Blur the SMALL box, then scale it up.
    //
    // A CSS filter runs in the element's own coordinate space, before its
    // transform. The canvas is laid out at its backing-store size -- a quarter
    // of the viewport in each direction -- given a blur a quarter as wide, and
    // then scaled back to full size. The visible result is the same blur; the
    // convolution runs over a sixteenth of the pixels.
    //
    // This is the same trick this fork used to apply to the theme's own
    // background layers before those were deleted, and it matters much more
    // here, because every panel now filters this canvas as its backdrop. What
    // was one expensive blur is one expensive blur that a dozen backdrop-filter
    // surfaces are waiting on, ten times a second.
    const scale = RES;
    const bw = `calc((100% + ${o * 2}px) / ${scale})`;
    const bh = bw;
    style.textContent = `
      #lqx-fabric{position:fixed;top:${-o}px;left:${-o}px;
        width:${bw};height:${bh};z-index:0;pointer-events:none;
        transform:scale(${scale});transform-origin:0 0;
        filter:blur(${(px / scale).toFixed(2)}px) brightness(${DIM})}
      html.liquify-perf #lqx-fabric{filter:blur(${(px / scale / 2).toFixed(2)}px) brightness(${DIM})}`;
    resize();
  }

  // ---- shader ----

  // The warp, as one source string, because TWO passes evaluate it now: the
  // background, and the glass pass below. If they ever disagreed by a single
  // term the glass would show a differently-deformed image than the wall it is
  // set into, and the panels would look like windows onto another room.
  const PULL_GLSL = `
  // One smooth function of position, evaluated per pixel. Every term is
  // C-infinity: a Gaussian has no cutoff ridge and no singularity at its
  // centre, so there is no place in the frame where the deformation can kink.
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
    // Pinned at the frame. Everything the pull drags past the texture border
    // is either a smeared edge pixel or a mirrored copy of the cover, and the
    // comment above the ZOOM constant picks the smear on the grounds that it
    // "is indistinguishable from the image simply continuing" under this much
    // blur -- which was true at a background blur of 38 and is not true at 12.
    // Rather than re-litigate which artefact is prettier, this removes the
    // question: taper the deformation to zero at the edge and the sample never
    // leaves the texture, so there is no outside to define. The interior keeps
    // the full warp, and a sheet that is still at its frame and moving in the
    // middle is what a sheet held at its frame actually does.
    vec2 edge = smoothstep(vec2(0.), vec2(0.17), p) * smoothstep(vec2(0.), vec2(0.17), 1.-p);
    return d*uAmp*edge.x*edge.y;
  }`;

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

  ${PULL_GLSL}

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
  // Kept so a glass context that was lost and restored can be refilled without
  // waiting for the next track.
  let lastImg = null;

  // Name That Tune blanks the cover art, the track name and the play bar for
  // the song you are meant to guess -- and then this background painted that
  // very album across the whole screen, answering the question before the first
  // snippet finished. So while a round is up the artwork is HELD: whatever was
  // showing when the round started stays up, and the round's own cover arrives
  // only when the answer does.
  //
  // Three signals, because no one of them covers every way a round can be
  // entered or left, and the first two attempts each shipped with a hole:
  //
  //  1. The game's own --guessing class. Synchronous and exact where it exists:
  //     nextSong() sets it BEFORE calling Player.next(), which is the only
  //     thing that closes the race against that track's songchange. But the app
  //     sets its classes from a History.listen callback and nowhere else, so
  //     they are missing entirely when Spotify restores the game's route at
  //     launch. (liquify-ui-tweaks repairs that; this does not rely on it.)
  //
  //  2. The track being guessed, remembered by URI across navigation and
  //     restarts. Without this, walking out of the game mid-round released the
  //     hold, loaded the mystery cover, and -- worse -- SAVED it as the cover
  //     to fall back on, so the next launch came up showing the answer. That is
  //     the bug this signal exists for: the mystery track must stay concealed
  //     while it is still the mystery track, wherever you happen to be looking.
  //
  //  3. Being on the game's route with no reveal panel rendered. Covers the
  //     ~800ms at startup when the route is restored but nothing has rendered
  //     and no class has been set, which is exactly when refreshArt would
  //     otherwise load the mystery cover.
  const ROUND_KEY = 'liquify-fabric-ntt-round';
  const NTT_ROUTE = /^\/name-that-tune/;

  const onGameRoute = () => NTT_ROUTE.test(Spicetify.Platform?.History?.location?.pathname || '');
  const revealed = () => !!document.querySelector('.name-that-tune-module__reveal');
  const nowUri = () => Spicetify.Player.data?.item?.uri || '';

  // Mirrored in memory so the 300ms release poll below is not a localStorage
  // read (and a write) three times a second. localStorage is the durable copy,
  // read once at startup, which is the only time this process cannot already
  // know the answer.
  let roundUri = localStorage.getItem(ROUND_KEY) || '';
  const setRound = (uri) => {
    if (uri === roundUri) return;
    roundUri = uri;
    try { uri ? localStorage.setItem(ROUND_KEY, uri) : localStorage.removeItem(ROUND_KEY); } catch {}
  };

  const holding = () =>
    document.body.classList.contains('name-that-tune--guessing') ||
    (!!roundUri && roundUri === nowUri()) ||
    (onGameRoute() && !revealed());

  // What is on the shader, remembered across restarts. Only needed for one
  // case, but it is the common one: boot straight into a held round and there
  // IS no previous song this session, so with nothing to fall back on the
  // background comes up empty. This is the cover from before Spotify was
  // closed -- genuinely the last thing that played.
  const ART_KEY = 'liquify-fabric-last-art';

  // `force` loads a specific cover regardless of the hold; it is how the
  // remembered one gets in. Everything else passes nothing and follows player.
  async function refreshArt(force) {
    const url = force || artUrl();
    if (!url || url === lastUrl) return;
    // Before lastUrl is written, so the release still sees this url as new and
    // loads it. Recording it here would hold the art until the song after next.
    if (!force && holding()) { syncHold(); return; }
    lastUrl = url;
    const img = await new Promise((r) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';       // i.scdn.co sends CORS headers
      i.onload = () => r(i); i.onerror = () => r(null);
      i.src = url;
    });
    if (!img) return;
    lastImg = img;
    // Set immediately before the upload rather than once at startup: this is
    // context state, and a context loss silently returns it to false.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const target = toB ? texB : texA;
    gl.activeTexture(toB ? gl.TEXTURE1 : gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    glassUpload(img, toB, !haveArt);
    if (!haveArt) {                       // first track: fill both, no crossfade
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      mixv = toB ? 1 : 0; haveArt = true;
    }
    fadeTo = toB ? 1 : 0;
    toB = !toB;
    // Only what is legitimately the current cover is worth remembering. A
    // held load (the stored cover being put back at startup) must not rewrite
    // the store, and a load that raced a hold must not either.
    try { if (!holding()) localStorage.setItem(ART_KEY, url); } catch {}
  }
  let fadeTo = 0;

  // Catches the release. songchange cannot: the track the hold skipped is
  // already playing by the time the answer is revealed, so nothing further is
  // emitted for it.
  //
  // A poll, deliberately, and not an observer: the element worth watching for
  // is created deep inside a custom app's own subtree, and waiting for it means
  // a subtree observer over the whole document -- the shape that once starved
  // this renderer. This timer exists ONLY while a round is being held. It
  // starts when a hold first bites and clears itself the moment the hold lifts,
  // so outside the game there is no timer at all.
  //
  // Declared before the first refreshArt() call rather than after it: that call
  // reaches syncHold on the boot-into-the-game path, and holdPoll would still
  // be in its temporal dead zone.
  let holdPoll = null;

  // The only place the remembered round is written. holding() stays a pure
  // read, because refreshArt calls it too and a predicate that also records
  // state is a predicate that lies depending on who asked.
  function trackRound() {
    const uri = nowUri();
    if (onGameRoute()) {
      // The answer is on screen, so there is nothing left to conceal.
      if (revealed()) setRound('');
      else if (uri) setRound(uri);
      return;
    }
    // Off the game and playing something else: whatever round was open has
    // been left behind. Playing the SAME track still counts as the round --
    // that is the case that used to leak the answer.
    if (uri && roundUri && roundUri !== uri) setRound('');
  }

  function syncHold() {
    trackRound();
    if (holding()) {
      if (!holdPoll) holdPoll = setInterval(syncHold, 300);
      // Booting into a round: the hold is correct, but it has nothing to hold
      // ON to, because no cover has been loaded this session. The stored one is
      // the song that played before Spotify was closed.
      if (!haveArt) { const last = localStorage.getItem(ART_KEY); if (last) refreshArt(last); }
      return;
    }
    if (holdPoll) { clearInterval(holdPoll); holdPoll = null; }
    refreshArt();
  }

  // Wrapped: the listener is handed an event, and refreshArt now reads its
  // first argument as a cover to force.
  // Through syncHold rather than straight to refreshArt: a song change is also
  // how a round begins and how one is abandoned, so the remembered round has to
  // be brought up to date before anything decides whether to load a cover.
  Spicetify.Player.addEventListener('songchange', syncHold);
  syncHold();                                  // also the initial refreshArt
  try { Spicetify.Platform.History.listen(syncHold); } catch {}

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
    // The edge taper, matching the shader exactly. If only one of the two
    // carried it the subtracted frame average would no longer be the average of
    // the field actually applied, and the mean-zero property that keeps the
    // composition from sliding off the texture would be quietly wrong.
    const sm = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
    const e = sm(px / 0.17) * sm((1 - px) / 0.17) * sm(py / 0.17) * sm((1 - py) / 0.17);
    return [dx * amp * e, dy * amp * e];
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
    const o = OVER(lastBlur < 0 ? cfg().blur : lastBlur);
    const w = Math.max(160, Math.round((window.innerWidth + o * 2) / RES));
    const h = Math.max(120, Math.round((window.innerHeight + o * 2) / RES));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('resize', () => { glassResize(); measurePanels(); });

  // Set only by renderOnce below. The loop deliberately does nothing while the
  // window is hidden, which is also the state any remote debugging session is
  // in by definition -- so without a way to override it, a rendering change
  // cannot be tested at all except by asking someone to look at the screen.
  let forceFrame = false;

  function frame(now) {
    if (!running && !forceFrame) return;
    if (!forceFrame) requestAnimationFrame(frame);
    const { strength, speed, blur, fps } = cfg();
    if ((document.hidden && !forceFrame) || strength <= 0 || !haveArt) return;
    // Ten frames a second, not sixty, and this is the single most expensive
    // number in the theme.
    //
    // Every panel filters its backdrop, and this canvas IS that backdrop -- so
    // repainting it does not cost one canvas repaint, it invalidates every
    // backdrop-filtered surface on the screen and they all recompute. Measured
    // by sweeping this value with the glass on, counting presented frames:
    //
    //     background 60fps -> UI 14.9    background 15fps -> UI 28.0
    //     background 30fps -> UI 14.5    background 10fps -> UI 49.7
    //     background 20fps -> UI 14.4
    //
    // Nothing else moved that number. Dropping the three biggest panels from
    // the filter: no change. Putting them on a two-primitive filter instead of
    // nine: no change. Freezing the background: straight to 60. It was never
    // the area or the chain, it was the invalidation, and this is the knob for
    // it. The drift is a slow warp under a heavy blur, so ten steps a second is
    // not visibly different from sixty -- and it is the difference between the
    // app running at 15fps and at 50.
    //
    // The crossfade is the exception and it has to be, because it is the one
    // thing here that is fast: a track change resolves in about 1.7s at 0.06 a
    // frame, which at 10fps would take ten seconds of visible stepping.
    const crossfading = mixv !== fadeTo;
    if (!forceFrame && now - last < 1000 / (crossfading ? 60 : fps)) return;
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
    // Snap when it is close enough to see, so the glass shader's uniform branch
    // on uMix can take its one-cover path. A geometric converger never arrives:
    // left alone it sits a thousandth away from its target for the rest of the
    // song and keeps both covers being fetched for every tap.
    if (Math.abs(fadeTo - mixv) < 0.001) mixv = fadeTo;
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

    // Same frame, same warp state, same instant -- which is the whole reason
    // this lives in here rather than running its own loop.
    if (glassWanted()) drawGlass(t, g, w, mx, my, amp, mixv, blur, strength);
  }

  // ---- glass pass ---------------------------------------------------------
  //
  // The chrome panels -- nav bar, main view, right sidebar -- are transparent
  // boxes with a rim and no backdrop-filter of their own. Giving them one is a
  // single CSS rule, and it was measured: on-screen filtered area goes from
  // 0.10 megapixels to 1.37, which is 101% of the viewport, because those three
  // panels tile the screen. Every one of those pixels re-composites on every
  // frame the background moves, and this background moves continuously.
  //
  // So the glass for those three is drawn HERE instead, into a second canvas
  // that sits between the background and the DOM. It costs one texture read per
  // pixel in a pass at half resolution, against a full-viewport composite of
  // separately-filtered surfaces. Same picture, a fraction of the work.
  //
  // WHAT THIS CANNOT DO, and it is a hard limit rather than a missing feature:
  // a canvas is at the BOTTOM of the stack, so anything painted into it is
  // behind all DOM. It can only stand in for a panel that has nothing but the
  // background behind it. The play bar floats over the main view's track list,
  // so its glass has to keep refracting real DOM pixels and stays on
  // backdrop-filter -- it is 0.09 megapixels, which is not worth solving. Same
  // for menus, tooltips and modals. This is the same wall the earlier
  // liquify-glass-gl attempt hit from the other side: a WebGL canvas cannot
  // sample DOM pixels.
  //
  // Turn off with localStorage liquify-shader-glass = 'off'.
  //
  // It was off for one revision, while the three containers were moved onto the
  // same SVG displacement filter as every other glass surface so the theme
  // would have exactly one mechanism. That is the better answer on paper and it
  // took the app to 75-90% GPU: those three are about 1.15 of the 2.1 filtered
  // megapixels on screen, and a filter graph over that area re-runs every time
  // this canvas repaints underneath it. Measured against the same window with
  // no CSS glass at all, it was 31 frames a second against 56.
  //
  // They are back here, and the look does not suffer for it, because a
  // displacement filter needs an EDGE to work on and there is none behind these
  // panels -- what they filter is this canvas, blurred before they ever see it.
  const GLASS_KEY = 'liquify-shader-glass';
  const glassWanted = () => localStorage.getItem(GLASS_KEY) !== 'off';

  // Half resolution rather than the background's quarter. The background can be
  // coarse because a CSS blur is smeared over it afterwards; this canvas has no
  // filter on it at all, so its panel EDGES are visible and want the extra
  // resolution. Still a quarter of the pixels of a full-res pass.
  const GLASS_RES = 2;
  const MAXP = 6;
  // Taps in the blur disc.
  //
  // Sixteen, not eight. Eight was chosen when every tap cost TWO texture reads
  // -- both covers, blended -- and it showed: the disc has to carry whatever
  // blur radius the mip cannot, and at eight points a 12px radius is eight
  // visibly separate copies of the picture rather than a blur. That is the
  // "choppy" in choppy blur.
  //
  // What pays for it is the uniform branch on uMix in samp() below. The
  // crossfade between the outgoing and incoming cover is only live for about a
  // second after a track change; outside that, one of the two reads was being
  // multiplied by zero. Skipping it halves the cost of a tap, so the disc gets
  // twice the points for the same sixteen reads this pass has always done --
  // and during the crossfade it briefly costs what three-quarters of a second
  // of album art is worth.
  const TAPS = 16;
  const PANELS = ['.Root__nav-bar', '.Root__main-view', '.Root__right-sidebar'];


  const gCanvas = document.createElement('canvas');
  gCanvas.id = 'lqx-glass';
  const g2 = gCanvas.getContext('webgl2', { alpha: true, antialias: false, depth: false });

  const glassStyle = document.createElement('style');
  glassStyle.id = 'lqx-glass-style';
  glassStyle.textContent =
    `#lqx-glass{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none}` +
    // The panels must not ALSO filter their own backdrop: that would blur the
    // glass this pass just drew for them, on top of blurring the background,
    // and put back the very cost this exists to avoid.
    `html.lqx-glass-on :is(${PANELS.join(',')}){backdrop-filter:none!important;` +
    `-webkit-backdrop-filter:none!important}`;
  document.head.appendChild(glassStyle);

  const GFS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uA, uB;
  uniform float uMix, uT, uAmp, uZoom, uLod, uRefract, uTint, uEdge, uSpread;
  uniform vec2 uCover, uMean, uRes;
  uniform vec4 uVp;      // xy = viewport/overscan scale, zw = offset
  uniform float uSheen;  // width of the rim highlight, canvas px
  uniform vec4 uGrip[${GRIPS}];
  uniform vec2 uGW[${GRIPS}];
  uniform vec4 uRect[${MAXP}];    // xy = top-left, zw = size, in canvas pixels
  uniform float uRad[${MAXP}];
  uniform int uCount;

  ${PULL_GLSL}

  // The tap disc, as constants. The angle and radius depend only on the loop
  // index, so the sin/cos/sqrt in the loop were computing the same 48 numbers
  // for every pixel of every frame and hoping the driver would fold them.
  // Golden-angle spiral: it fills a disc evenly at any count, with no lattice
  // for the image to alias against.
  //
  // RECENTRED so the sixteen offsets sum to zero. A finite golden-angle spiral
  // does not -- these sixteen have a centroid 0.03 of the radius off-centre --
  // so the blur was very slightly lopsided, always in the same direction.
  // Subtracting the mean costs nothing at run time.
  const vec2 DISC[${TAPS}] = vec2[${TAPS}](
    vec2( 0.189936, 0.027087), vec2(-0.212612, 0.233913),
    vec2( 0.047718,-0.366684), vec2( 0.297731, 0.398260),
    vec2(-0.509063,-0.065287), vec2( 0.507855,-0.287598),
    vec2(-0.152306, 0.642612), vec2(-0.302402,-0.580507),
    vec2( 0.697802, 0.277117), vec2(-0.699096, 0.321096),
    vec2( 0.356514,-0.706642), vec2( 0.266890, 0.836019),
    vec2(-0.751586,-0.416099), vec2( 0.910294,-0.170145),
    vec2(-0.534347, 0.805859), vec2(-0.113327,-0.949003));

  // One sample of the artwork at the working mip level.
  //
  // The crossfade between the outgoing and incoming cover only runs for a few
  // hundred milliseconds after a track change. The rest of the time uMix sits
  // at exactly 0 or 1 and the mix() is a second full texture read whose result
  // is multiplied by zero -- half of this pass's texture traffic, thrown away,
  // permanently. Branching on a UNIFORM costs nothing: every invocation in the
  // draw takes the same side, so there is no warp divergence to pay for, and
  // textureLod takes an explicit level so it is legal in any control flow
  // (texture() would not be -- it needs derivatives).
  vec3 samp(vec2 uv, float lod){
    if (uMix <= 0.001) return textureLod(uA, uv, lod).rgb;
    if (uMix >= 0.999) return textureLod(uB, uv, lod).rgb;
    return mix(textureLod(uA, uv, lod), textureLod(uB, uv, lod), uMix).rgb;
  }

  float sdRound(vec2 p, vec2 halfSize, float r){
    vec2 q = abs(p) - halfSize + r;
    return min(max(q.x, q.y), 0.) + length(max(q, vec2(0.))) - r;
  }

  // Distance to the nearest panel edge: negative inside, positive outside.
  // The out-parameter reports the panel that owns that distance, because the
  // refraction below needs that rectangle's own geometry, not just how far
  // away it is.
  float panels(vec2 fp, out int which){
    float d = 1e9;
    which = 0;
    for (int i=0;i<${MAXP};i++){
      if (i >= uCount) break;
      vec4 r = uRect[i];
      float di = sdRound(fp - (r.xy + r.zw*.5), r.zw*.5, uRad[i]);
      if (di < d) { d = di; which = i; }
    }
    return d;
  }

  void main(){
    // Canvas pixels, y down, to match the rectangles handed in from layout.
    vec2 fp = vec2(vUv.x, 1.-vUv.y) * uRes;
    int hit;
    float d = panels(fp, hit);
    // One pixel of feather, so the rounded corners are not staircases.
    float inside = 1. - smoothstep(-1., 0., d);
    if (inside <= 0.002) { outColor = vec4(0.); return; }

    // Refraction. A slab of glass bends hardest where it curves, which is at
    // its edge, so the sample is pushed outward by an amount that falls off
    // with depth.
    //
    // NOT from the distance field, which is the obvious way and is wrong. A
    // rounded-box SDF is exact outside the box and only approximate inside it:
    // the interior term is min(max(q.x,q.y),0), and max() has a gradient
    // discontinuity where q.x == q.y -- the 45-degree diagonal out of each
    // corner. The mask above only reads the field within a pixel of the border,
    // where it is accurate, but a rim that falls off over 26px reads it deep
    // inside, and the discontinuity shows up as a visible crease running
    // diagonally from every corner.
    //
    // So the rim is built per axis instead, from the distance to each pair of
    // edges, and combined as a smooth union rather than a max. Two ramps
    // multiplied have no seam anywhere, the corner blends both directions
    // naturally, and it drops the four extra field evaluations the numeric
    // gradient needed.
    vec2 half2 = uRect[hit].zw * .5;
    vec2 rel = fp - (uRect[hit].xy + half2);
    vec2 toEdge = half2 - abs(rel);
    float rx = 1. - smoothstep(0., uEdge, toEdge.x);
    float ry = 1. - smoothstep(0., uEdge, toEdge.y);
    float rim = 1. - (1. - rx) * (1. - ry);
    vec2 n = normalize(vec2(sign(rel.x) * rx, sign(rel.y) * ry) + 1e-5);

    // Into the BACKGROUND's coordinate space before sampling anything.
    //
    // This pass and the background pass evaluate the same warp on the same
    // cover, and until this existed they disagreed about where they were. The
    // background canvas runs past the viewport by OVER pixels a side so its CSS
    // blur fades off-screen; this one is exactly viewport-sized, because its
    // panel rectangles come from layout. Both then computed
    // t = (vUv-.5)*uCover+.5 from their own vUv, so the background fitted the
    // cover across 1736 screen pixels and the glass fitted it across 1470 -- an
    // 18% scale difference, plus an offset.
    //
    // It showed exactly as you would expect once you know what to look for.
    // Scanning luminance across a panel border: the glass was 16/255 BRIGHTER
    // than the wall it is set into at the left edge, and 15/255 DARKER at the
    // right edge. Opposite signs on opposite sides is a shift, not a tint --
    // the panel was showing a slightly different part of the picture.
    //
    // uVp maps this canvas's 0..1 onto the background's 0..1. The bend is a
    // fraction of the viewport, so it scales the same way. The panel geometry
    // above stays in vUv, which is the space its rectangles are measured in.
    vec2 sUv = vUv * uVp.xy + uVp.zw;
    vec2 bend = n * rim * uRefract * vec2(1., -1.) / uRes * uVp.xy;
    vec2 uv0 = sUv + bend;

    vec2 uv = uv0 + (pull(uv0) - uMean);
    vec2 t = (uv-.5)*uCover*uZoom + .5;

    // Blur as a mip level PLUS a tap disc, rather than mip level alone.
    //
    // One read at a high mip is the cheap way and it falls apart exactly where
    // it is asked to work hardest: mip 5 of a 640px cover is a 20px image, and
    // stretching 20 pixels across a 656px panel is not a blur, it is a
    // low-resolution image. That is the "why does it look low quality when I
    // blur it" -- the more blur asked for, the smaller the image it was
    // magnifying.
    //
    // So the mip is held to a level that still has detail and the rest of the
    // radius comes from spreading the taps. Points on a golden-angle spiral,
    // which fills a disc evenly at any count without a pattern to alias with.
    vec3 acc = vec3(0.);
    for (int i=0;i<${TAPS};i++) acc += samp(t + DISC[i] * uSpread, uLod);
    vec3 col = acc / float(${TAPS});


    // Brighter than the background it is set into (that layer is dimmed to
    // .45), which is what reads as "this panel is lit from within".
    col *= uTint;
    // A cool highlight along the rim, on its OWN width -- not the bend's.
    //
    // This used to ride rim, which eases over uEdge. That was fine while
    // uEdge was 26 canvas pixels and wrong the moment it became 52, because
    // uEdge is the distance the glass takes to finish bending and it wants to be
    // generous: a slab that changes shape inside a finger's width reads as a
    // crease. A highlight wants the opposite. At 52 the sheen became a band 104
    // screen pixels wide adding 0.06 -- fifteen of 255 -- to every panel, and
    // since it rings all four sides of panels only 200 to 650 pixels across,
    // most of a sidebar sat inside it. Scanned across a panel border: 88/255 in
    // the exposed background, 103 four pixels inside the panel, decaying back to
    // 89 eighty pixels in. That step is the whole of "the panels look different
    // from the background" -- the panel interior was already an exact match, and
    // this was painted on top of it.
    //
    // Twelve screen pixels now, built like rim itself out of two per-axis ramps
    // joined as a smooth union so it stays continuous through the corners.
    float sx = 1. - smoothstep(0., uSheen, toEdge.x);
    float sy = 1. - smoothstep(0., uSheen, toEdge.y);
    float lip = 1. - (1. - sx) * (1. - sy);
    col += lip * lip * 0.06;
    outColor = vec4(col * inside, inside);   // premultiplied
  }`;

  let gProg, gUni, gTexA, gTexB, glassReady = false;

  const gMkTex = () => {
    const t = g2.createTexture();
    g2.bindTexture(g2.TEXTURE_2D, t);
    g2.texParameteri(g2.TEXTURE_2D, g2.TEXTURE_WRAP_S, g2.CLAMP_TO_EDGE);
    g2.texParameteri(g2.TEXTURE_2D, g2.TEXTURE_WRAP_T, g2.CLAMP_TO_EDGE);
    // The mip chain IS the blur, so it has to be filtered between levels as
    // well as within one, or the glass steps between blur radii as the warp
    // moves the sample across a level boundary.
    g2.texParameteri(g2.TEXTURE_2D, g2.TEXTURE_MIN_FILTER, g2.LINEAR_MIPMAP_LINEAR);
    g2.texParameteri(g2.TEXTURE_2D, g2.TEXTURE_MAG_FILTER, g2.LINEAR);
    g2.texImage2D(g2.TEXTURE_2D, 0, g2.RGBA, 1, 1, 0, g2.RGBA, g2.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    g2.generateMipmap(g2.TEXTURE_2D);
    return t;
  };

  function initGlass() {
    if (!g2) return false;
    try {
      const compileG = (type, src) => {
        const sh = g2.createShader(type);
        g2.shaderSource(sh, src); g2.compileShader(sh);
        if (!g2.getShaderParameter(sh, g2.COMPILE_STATUS)) throw new Error(g2.getShaderInfoLog(sh));
        return sh;
      };
      gProg = g2.createProgram();
      g2.attachShader(gProg, compileG(g2.VERTEX_SHADER, VS));
      g2.attachShader(gProg, compileG(g2.FRAGMENT_SHADER, GFS));
      g2.linkProgram(gProg);
      if (!g2.getProgramParameter(gProg, g2.LINK_STATUS)) throw new Error(g2.getProgramInfoLog(gProg));
      g2.useProgram(gProg);
      const U = (n) => g2.getUniformLocation(gProg, n);
      gUni = { A: U('uA'), B: U('uB'), mix: U('uMix'), t: U('uT'), amp: U('uAmp'),
               cover: U('uCover'), zoom: U('uZoom'), mean: U('uMean'), res: U('uRes'),
               grip: U('uGrip'), gw: U('uGW'), rect: U('uRect'), rad: U('uRad'),
               count: U('uCount'), lod: U('uLod'), refract: U('uRefract'),
               tint: U('uTint'), edge: U('uEdge'), spread: U('uSpread'),
               vp: U('uVp'), sheen: U('uSheen') };
      g2.uniform1i(gUni.A, 0);
      g2.uniform1i(gUni.B, 1);
      g2.enable(g2.BLEND);
      g2.blendFunc(g2.ONE, g2.ONE_MINUS_SRC_ALPHA);   // premultiplied
      gTexA = gMkTex();
      gTexB = gMkTex();
      glassReady = true;
      return true;
    } catch (err) {
      console.warn('[liquify-fabric-bg] glass pass unavailable:', err.message);
      glassReady = false;
      return false;
    }
  }
  initGlass();

  gCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); glassReady = false; });
  gCanvas.addEventListener('webglcontextrestored', () => {
    if (initGlass()) glassUpload(lastImg, false, true);
  });

  // The same cover, uploaded again. Two contexts cannot share a texture, so the
  // choice is a second upload per track change or a second copy of the whole
  // background pass -- and an upload of one 640px image every few minutes is
  // the cheaper of those by a wide margin.
  function glassUpload(img, toB, both) {
    if (!glassReady || !img) return;
    g2.pixelStorei(g2.UNPACK_FLIP_Y_WEBGL, true);
    const target = toB ? gTexB : gTexA;
    g2.activeTexture(toB ? g2.TEXTURE1 : g2.TEXTURE0);
    g2.bindTexture(g2.TEXTURE_2D, target);
    g2.texImage2D(g2.TEXTURE_2D, 0, g2.RGBA, g2.RGBA, g2.UNSIGNED_BYTE, img);
    g2.generateMipmap(g2.TEXTURE_2D);
    if (both) {
      g2.activeTexture(g2.TEXTURE0); g2.bindTexture(g2.TEXTURE_2D, gTexA);
      g2.texImage2D(g2.TEXTURE_2D, 0, g2.RGBA, g2.RGBA, g2.UNSIGNED_BYTE, img);
      g2.generateMipmap(g2.TEXTURE_2D);
    }
  }

  // Panel geometry, read from layout rather than assumed.
  //
  // Watched rather than polled: a ResizeObserver fires exactly when one of
  // these boxes changes and never otherwise, which matters because the main
  // view's width changes the moment the friend feed opens or closes. Reading
  // the rectangles in the frame loop instead would be a forced layout sixty
  // times a second to learn a number that changes a few times an hour.
  const rectBuf = new Float32Array(MAXP * 4);
  const radBuf = new Float32Array(MAXP);
  let panelCount = 0;
  function measurePanels() {
    let n = 0;
    for (const sel of PANELS) {
      if (n >= MAXP) break;
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      rectBuf[n * 4] = r.left / GLASS_RES;
      rectBuf[n * 4 + 1] = r.top / GLASS_RES;
      rectBuf[n * 4 + 2] = r.width / GLASS_RES;
      rectBuf[n * 4 + 3] = r.height / GLASS_RES;
      radBuf[n] = (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) / GLASS_RES;
      n++;
    }
    panelCount = n;
  }

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => measurePanels());
    // The panels are created and destroyed as routes change, so the set to
    // watch is re-checked on the same slow tick that re-mounts the canvas.
    const watched = new WeakSet();
    const watch = () => {
      for (const sel of PANELS) {
        const el = document.querySelector(sel);
        if (el && !watched.has(el)) { watched.add(el); ro.observe(el); }
      }
    };
    watch();
    setInterval(watch, 2000);
  }

  function glassResize() {
    const w = Math.max(160, Math.round(window.innerWidth / GLASS_RES));
    const h = Math.max(120, Math.round(window.innerHeight / GLASS_RES));
    if (gCanvas.width !== w || gCanvas.height !== h) {
      gCanvas.width = w; gCanvas.height = h; g2.viewport(0, 0, w, h);
    }
  }

  let glassFrames = 0;
  function drawGlass(t, g, w, mx, my, amp, mixNow, blur, strength) {
    if (!glassReady || !panelCount) return;
    glassFrames++;
    glassResize();
    // The BACKGROUND canvas's aspect, not this one's. The cover fit has to be
    // the background's, or the two show the picture at different scales -- the
    // same disagreement uVp fixes for position.
    const A = canvas.width / canvas.height;
    // This canvas covers the viewport; the background covers the viewport plus
    // OVER pixels a side.
    const o = OVER(cfg().blur);
    const tw = window.innerWidth + o * 2, th = window.innerHeight + o * 2;
    g2.uniform4f(gUni.vp, window.innerWidth / tw, window.innerHeight / th, o / tw, o / th);
    g2.useProgram(gProg);
    g2.activeTexture(g2.TEXTURE0); g2.bindTexture(g2.TEXTURE_2D, gTexA);
    g2.activeTexture(g2.TEXTURE1); g2.bindTexture(g2.TEXTURE_2D, gTexB);
    g2.uniform1f(gUni.mix, mixNow);
    g2.uniform1f(gUni.t, t);
    g2.uniform1f(gUni.amp, amp);
    g2.uniform2f(gUni.mean, mx, my);
    g2.uniform2f(gUni.cover, 1, 1 / A);
    g2.uniform1f(gUni.zoom, ZOOM);
    g2.uniform2f(gUni.res, gCanvas.width, gCanvas.height);
    g2.uniform4fv(gUni.grip, g);
    g2.uniform2fv(gUni.gw, w);
    g2.uniform4fv(gUni.rect, rectBuf);
    g2.uniform1fv(gUni.rad, radBuf);
    g2.uniform1i(gUni.count, panelCount);
    // Driven by the Background settings, not by constants.
    //
    // This matters far more than it looks: the three panels cover about 95% of
    // the window, so once this pass draws them, hardcoding its look here means
    // the Blur and Warp sliders visibly do nothing -- they would only still
    // reach the few slivers of background between panels. Anything the sliders
    // control has to be plumbed through to here or it stops being a setting.
    //
    // Blur is split between the two. The cover is 640px drawn across roughly
    // 1470, so one screen pixel is about 0.44 texture pixels. The tap disc
    // carries the radius, and the mip is chosen to make the taps JOIN UP.
    //
    // That second half used to be log2(rTex) -- the coarsest mip the radius
    // allows -- and it is what made the blur look chopped. Two separate
    // artefacts came out of it. A mip that coarse is a small picture magnified:
    // at blur 12 it read a 128px image across a 656px panel, so the bilinear
    // upsample showed as soft rectangles. And the taps then sat further apart
    // than the texels they were fetching, so each one landed as its own visible
    // copy of the art rather than overlapping its neighbours into a blur.
    //
    // The rule instead: N golden-angle points on a disc of radius r sit about
    // r*sqrt(pi/N) apart, which is 0.44r at sixteen taps, so a texel of r/2 is
    // just wide enough to close the gaps with margin. That is log2(r) - 1.
    const rTex = Math.max(1, blur) * 0.44;
    const spread = rTex / 640;
    g2.uniform1f(gUni.lod, Math.max(0, Math.min(4, Math.log2(rTex) - 1)));
    g2.uniform1f(gUni.spread, spread);
    // The rim bend is part of the warp, so it answers to the same slider.
    //
    // The band is 52 canvas pixels now rather than 26, and the peak bend is
    // lower to match. Same idea, half the rate of change: at 26 the whole
    // deformation happened inside about a finger's width of the panel border
    // and the middle of a panel was perfectly flat, which is what reads as the
    // edges being distorted and nothing else. Real glass of any thickness bends
    // over a distance you can see. Spreading it also spreads the dispersion,
    // which is measured from this same vector.
    const warp = Math.max(0, Math.min(1, strength / 100));
    g2.uniform1f(gUni.refract, 20 * warp);
    g2.uniform1f(gUni.edge, 52);
    // The highlight's own width, deliberately unrelated to uEdge above.
    g2.uniform1f(gUni.sheen, 6);
    // The SAME dimming as the background, not a step above it.
    //
    // "Lit from within" was a nice idea and the wrong one here: the panels
    // cover about 95% of the window, so a glass that is 38% brighter does not
    // read as lit, it reads as the exposed background being mysteriously dark.
    // The bright thing wins by area and the slivers between panels look like
    // the mistake. Glass is blur and refraction; it does not have to be brighter
    // than what it is set into.
    g2.uniform1f(gUni.tint, DIM);
    g2.clearColor(0, 0, 0, 0);
    g2.clear(g2.COLOR_BUFFER_BIT);
    g2.drawArrays(g2.TRIANGLES, 0, 3);
  }

  const mount = () => {
    const parent = document.querySelector('.Root__top-container');
    if (!parent) return false;
    if (canvas.parentElement !== parent) parent.insertBefore(canvas, parent.firstChild);
    // Immediately after the background, so it paints over it and under every
    // piece of DOM -- which is exactly the slot a panel's backdrop occupies.
    if (gCanvas.parentElement !== parent || gCanvas.previousSibling !== canvas) {
      parent.insertBefore(gCanvas, canvas.nextSibling);
    }
    return true;
  };
  function apply() {
    const on = cfg().strength > 0;
    // Blur is applied here as well as in the frame loop. The loop stops
    // entirely while the window is hidden or occluded (no requestAnimationFrame
    // is delivered at all), so a blur changed in that state would not reach the
    // canvas until the next frame -- which is one frame too late: the window
    // becomes visible showing the old blur and then pops. Applying it on the
    // 2s apply() tick means the canvas is already correct when the window
    // comes back.
    applyBlur(cfg().blur);
    document.documentElement.classList.toggle('lqx-fabric-on', on);
    canvas.style.display = on ? '' : 'none';

    const gOn = on && glassReady && glassWanted();
    document.documentElement.classList.toggle('lqx-glass-on', gOn);
    gCanvas.style.display = gOn ? '' : 'none';
    if (gOn) measurePanels();
    if (on && !running) { running = true; resize(); requestAnimationFrame(frame); }
    if (!on) running = false;
  }
  // ---- delete the theme's own background engine ----
  //
  // Liquify's startBackground() builds four things, and this canvas covers all
  // of them: two crossfading full-window cover layers, a container of four
  // 1948x1948 tiles each under a 50px blur and a running CSS spin, and a
  // full-window Kawarp div. Every one of them is prepended to
  // .Root__top-container, which puts them BELOW #lqx-fabric in the same
  // stacking context, so not one pixel of any of them has been visible since
  // this extension shipped.
  //
  // This used to hide them instead -- opacity:0, 1px, no filter -- on the
  // stated theory that Liquify samples the layer ELEMENTS to derive
  // --liquify-accent, so removing them would leave the accent stuck. That was
  // wrong. applyAccent() takes a URL, and getDominantColor() draws that URL
  // into an offscreen image (theme.js:2062-2075); the accent never reads the
  // document. render() writes only to the two elements its closure already
  // holds, so detaching them leaves it writing to detached nodes rather than
  // throwing.
  //
  // Verified in the running client before making the change, because "obviously
  // fine" is how the last two bugs here got shipped: with zero
  // .liquify-bg-layer elements in the tree, firing
  // liquifyAccentColorParamsChange still resolved a fresh accent
  // (rgb(255,89,137)), and eight consecutive ticks of the theme's own 500ms
  // background interval raised no error and no unhandled rejection.
  //
  // The Kawarp loop is separately inert here: syncLoop() only starts a
  // requestAnimationFrame while this.live is non-empty, and that set is filled
  // by ensureLayers(), reached only from show(), reached only when the backdrop
  // resolves to kind "animated". Forcing the mode off "animated" below closes
  // that door as well, and takes Kawarp's five dead sliders (Warp Intensity,
  // Animation Speed, Saturation, Scale, Contrast) out of the settings panel --
  // they were faithfully driving a canvas nobody could see, which is why the
  // Background section appeared to do nothing.
  //
  // Only done while the fabric background is actually on. Turn Distortion down
  // to 0 and the theme's own background is left alone rather than being
  // permanently disabled behind the user's back -- though it will need a reload
  // to come back, since these nodes are gone for the session.
  const BG_MODE_KEY = 'liquify-bg-mode';
  const THEME_BG = ['.liquify-bg-layer', '.liquify-animated-bg', '.liquify-kawarp-bg'];
  let stripped = 0;
  function standDownThemeBackground() {
    if (cfg().strength <= 0) return;
    for (const sel of THEME_BG) {
      for (const el of document.querySelectorAll(sel)) { el.remove(); stripped++; }
    }
    if (localStorage.getItem(BG_MODE_KEY) === 'animated') {
      localStorage.setItem(BG_MODE_KEY, 'dynamic');
      window.dispatchEvent(new Event('liquifyBackgroundChange'));
      console.log('[liquify-fabric-bg] theme animated background stood down (was covered by this one)');
    }
  }

  const boot = () => { if (!mount()) return setTimeout(boot, 600); resize(); applyBlur(cfg().blur); apply(); };
  boot();
  standDownThemeBackground();
  setInterval(() => { mount(); apply(); standDownThemeBackground(); }, 2000);

  window.liquifyFabric = {
    canvas, cfg,
    // Which cover is actually on the shader, and whether it is being held off
    // the player. Worth exposing rather than leaving in the closure: this
    // background deliberately lags the player during Name That Tune, so "is the
    // right art up" stops being answerable by looking at the now playing bar.
    get art() { return lastUrl; },
    get held() { return holding(); },
    // The glass pass renders into its own context and its own canvas, so when
    // it shows nothing there is no way to tell from the page whether it failed
    // to compile, failed to find its panels, or simply never ran.
    // Draws one frame with the visibility check bypassed; returns whether the
    // glass pass got as far as drawing.
    drawOnce: () => {
      forceFrame = true;
      try { frame(performance.now()); } finally { forceFrame = false; }
      return glassFrames;
    },
    get themeBgRemoved() { return stripped; },
    glass: () => ({
      ready: glassReady, wanted: glassWanted(), panels: panelCount,
      mounted: !!gCanvas.parentElement, size: [gCanvas.width, gCanvas.height],
      display: gCanvas.style.display, cls: document.documentElement.classList.contains('lqx-glass-on'),
      rects: Array.from(rectBuf.slice(0, panelCount * 4)),
      rads: Array.from(radBuf.slice(0, panelCount)),
      frames: glassFrames,
    }),
    set: (o = {}) => {
      const map = { strength: STRENGTH_KEY, speed: SPEED_KEY, blur: BLUR_KEY, fps: FPS_KEY };
      for (const k of Object.keys(map)) if (o[k] != null) localStorage.setItem(map[k], String(o[k]));
      apply(); return cfg();
    },
  };
  console.log('[liquify-fabric-bg] per-pixel warp active');
})();
