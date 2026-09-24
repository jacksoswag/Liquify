# Liquify (fork)

A fork of [NMWplays/Liquify](https://github.com/NMWplays/Liquify), the
glassmorphic Spicetify theme for Spotify (itself inspired by
[Glassify](https://github.com/sanoojes/spicetify-glassify)). It is Spotify-only:
the theme plus five extensions, installed from disk by `install.sh` and pinned
to Spotify 1.2.99.317. Upstream is not tracked; `theme.js` and `user.css`
started as upstream's and have diverged. AGPL-3.0, like upstream (see
`LICENSE.txt`).

## This fork

A rewrite of how Liquify draws its liquid glass, plus a keyboard layer, a
Name That Tune game and a settings cleanup. Five extensions:

| file | what it does |
|---|---|
| `liquify-fabric-bg.js` | the background, as a WebGL fragment shader, and the panel glass |
| `liquify-perf.js` | the shared SVG glass filter, shadow rules, the fabric sliders |
| `liquify-keys.js` | keyboard control (`alt+/` lists every binding) |
| `liquify-ui-tweaks.js` | settings merge and pruning, Liquid Lyrics desync repair |
| `liquify-ntt-modes.js` | source, difficulty and round settings for Name That Tune |

Two third-party pieces are vendored under `vendor/` (see its README): Liquid
Lyrics and the Name That Tune custom app.

### Installing, and staying installed

Nothing here depends on Marketplace or on Spotify's browser storage -- a
Spotify auto-update (1.2.99 -> 1.3.0, 2026-09-14) wiped both. `install.sh`
bakes the snippets into `user.css`, copies the extensions and the vendored
Liquid Lyrics, writes the load order into `config-xpui.ini`, and re-asserts
the version lock every time it runs (Spotify pinned to 1.2.99.317, updates
blocked, spicetify brew-pinned, a pristine copy of the app bundle kept
outside spicetify's state dir and restored when spicetify loses its own).

The settings-panel choices are the one thing that still lives in browser
storage. `settings.json` is a snapshot of them; `install.sh` seeds it in
front of `theme.js`, writing each key only if it is absent, so a wipe gets
the snapshot back and a choice made later in the panel is left alone. After
changing settings you want to keep, refresh the snapshot with
`snapshot-settings.sh` (Spotify has to be running with
`--remote-debugging-port=9222`; the script says how) and commit it. Quit
Spotify and open it normally afterwards, so the debugging port closes.

### Measurement method (read this before trusting any number)

Two confounds invalidate naive benchmarking of this app, and both produced
badly wrong numbers here before they were found:

1. **Occlusion.** Spotify's GPU use is ~0% while the window is not composited
   and 70-85% while it is. Any average that mixes hidden and visible samples is
   meaningless. Samples are discarded unless `visibilityState === 'visible'`
   and playback is running. This also makes GPU% unmeasurable over remote
   debugging, where the window is occluded by definition -- `ioreg -c
   IOAccelerator` reads the same 22% for every configuration.
2. **Baseline drift.** The baseline moves ~11 points as tracks change (album
   art, lyric density, canvas content), which swamps sequential block
   comparisons -- at one point "all glass off" measured *higher* than "with
   glass". Configs must be **interleaved** and compared per-cycle.

`Page.setWebLifecycleState('active')` pins the GPU near 80% on an occluded
window, so it must never be used while measuring. `Page.startScreencast` is
usable: it forces the compositor to keep producing frames, so a
requestAnimationFrame counter returns comparable per-frame times even though
the absolute values are inflated.

### GPU, measured

Medians of 7 interleaved cycles, playing music with the lyrics view open, at
1267x924. **These predate the shader background** and describe the fork as of
the `backdrop-filter` era; they have not been re-run under the same protocol
since, because the window has to be visible and unoccluded to measure at all.

| configuration | GPU (median) | range |
|---|---|---|
| stock Liquify | **80.9%** | 80.1-82.1 |
| this fork, look identical | **75.5%** | 72-78.1 |
| this fork + single-pass glass | **63.3%** | 60.1-68.3 |
| *all glass removed entirely* | *62.9%* | 59.8-69.8 |
| *all theme CSS stripped (~vanilla)* | *0.8%* | 0.2-3.5 |

The lasting conclusions from that run: **refraction is essentially free**
(single-pass displacement landed within 0.4 points of removing every
`backdrop-filter` in the app), and **the remaining ~63% is the theme's
aggregate paint structure**, not one property -- `box-shadow` ~6 points,
`text-shadow` ~3, `mix-blend-mode` ~1, with the rest only reachable by
stripping the theme wholesale. A sub-25% target is not reachable while keeping
this theme's appearance.

### The background is a shader

`liquify-bg-layer` and everything around it is gone. The album art is deformed
per pixel by a fragment shader on a quarter-resolution canvas, because
deformation has to be one continuous function: an SVG `feDisplacementMap` over
the rendered layer is invisible (that layer is already downscaled, blurred and
dimmed -- measured 1.3% mean pixel change) and ruinous with `feTurbulence`
(80 GPU points), and a Canvas 2D triangle mesh is piecewise-linear by
construction, so it always creases.

The theme's own background engine is **removed from the document** at runtime:
two crossfading cover layers, a container of four 1948x1948 tiles each under a
50px blur with a running CSS spin, and a full-window Kawarp div -- all of it
prepended below an opaque canvas, none of it visible since this fork shipped.
Nothing depends on those nodes: the accent is sampled from a URL, not from the
DOM, verified in the running client.

Details that took real debugging and are easy to undo by accident:

- The canvas is laid out **at its backing-store size and scaled up**, so its
  CSS blur convolves a sixteenth of the pixels for an identical result.
- It also runs **past the viewport** by ~2.5 sigma a side. A CSS blur is a
  convolution against the element's own rendering, so a canvas at `inset: 0`
  fades to transparent at every screen edge -- and those edges are the only
  background the panels do not cover. Measured at the default blur, the gaps
  read 53 and 17 against 91 for the same wall a few pixels further in.
- Blur is a mip level **plus** a 16-tap golden-angle disc, with the mip chosen
  so the taps overlap (`log2(r) - 1`). Taking the coarsest mip the radius
  allowed magnified a 128px image across a 656px panel *and* left the taps
  further apart than the texels they fetched, so each landed as its own visible
  copy of the art.
- `UNPACK_FLIP_Y_WEBGL` is **context** state, so it must be set before every
  upload; a context loss silently returns it to false and the art comes back
  upside down. And a context is only ever restored if `webglcontextlost` is
  `preventDefault`-ed. Hiding and reopening the window is enough to trigger a
  loss.

### The panel glass is a second shader pass

The three chrome containers (`Root__nav-bar`, `Root__main-view`,
`Root__right-sidebar`) get their blur and edge refraction drawn into a second
half-resolution canvas rather than through `backdrop-filter`. They are about
1.15 of the ~2.1 filtered megapixels a full-CSS version would cost, and a
filter graph over that area re-runs every time the background repaints
underneath it -- measured at 31 fps against 56 with no CSS glass at all.

Both passes evaluate an identical warp, and the two canvases are **different
coordinate spaces**: the background overscans, the glass pass is exactly
viewport-sized because its rectangles come from layout. Anything derived from
`vUv` has to be mapped between them or the two show the same cover at
different scales.

The rim highlight has its own width, deliberately unrelated to the bend's. The
bend wants to be generous -- glass that changes shape inside a finger's width
reads as a crease -- and a highlight wants the opposite. Sharing one width made
a 104-pixel band adding 15/255 to every panel, which read as the panels being a
different surface from the wall behind them. Panel interior now matches the
exposed background to within 0.5/255.

### One glass filter for everything else

The play bar, menus, tooltips and small controls stay on `backdrop-filter`,
because a canvas sits at the bottom of the stack and can only stand in for a
surface with nothing but background behind it.

- **Shared filter graph.** Stock Liquify builds one `liquify-filter-N` per
  glass surface (86 selectors, 15 live graphs on one view). Collapsed to one.
- **Raster displacement map.** `feImage` pointed at an SVG data-URI that Skia
  re-rasterizes *inside the filter graph* on every `ResizeObserver` fire; now a
  canvas-rendered PNG.
- **No chromatic aberration.** The filter had a second form running the
  displacement three times, once per channel. It cost 32 GPU points measured,
  it was sub-pixel on anything smaller than the play bar, and every attempt to
  make it worth that price either stayed invisible (1/255 against a 1/255 noise
  floor) or took the app to 90% GPU. Removed, not made optional.
- **Blur inside the filter, not after it.** The theme emits
  `backdrop-filter: var(--glass-filter) blur(var(--liquify-glass-blur, 2px))`,
  and a CSS filter list runs left to right, so the blur was landing on the
  refraction instead of the backdrop. Measured on the play bar over a track
  list: at `0px` you get refraction and no blur; at `2px`, refraction and a
  faint blur; at `18px`, **no refraction and a blur visibly weaker than a plain
  `backdrop-filter: blur(18px)`** on the same element, with legible text still
  coming through top and bottom. Same cause for both: the reference filter's
  region is its element's own box, so its output is clipped there before the
  CSS blur runs, leaving the blur nothing to sample past the edge. The blur is
  now the trailing `feGaussianBlur` in the shared graph
  (`stdDeviation = radius / 2`) with the filter region widened to 150% to give
  it room. Widening the region alone leaves the refraction pixel-identical, so
  this costs the blur and nothing else, on the same single backdrop surface.
- **`lqx-glass` was two elements.** The shared filter and
  liquify-fabric-bg.js's glass canvas both had that id, and `url(#lqx-glass)`
  resolves to whichever comes first in the document -- the filter, but only
  because this extension is listed before that one. The filter is `lqx-refract`
  now; the failure mode was every glass surface in the app silently losing its
  filter.
- **Dead backdrop elimination.** 115 of 137 glass surfaces were doing nothing:
  96 zero-area/offscreen, 12 at `opacity:0`, and 7 running `blur(0px)` -- a
  zero-radius blur is a visual no-op but still allocates a backdrop render
  surface.
- **`Root__top-container::after`** carried a full-viewport
  `backdrop-filter: brightness(2.12)` at `opacity: 0` on macOS -- 1.36
  megapixels of work multiplied by zero, more filtered area than every real
  glass surface combined. Switched off; the window changed by 0.056/255.

Filtered area is **0.104 megapixels, 8% of the viewport, five surfaces.**

Worth knowing if you touch the selector list: the theme shipped 89 glass
selectors and **80 of them matched nothing** on the views measured on Spotify
1.2.99. That, not the filter, is why the glass appears on so little. The 16
entries of `GLASS_TARGETS`/`PRECISE_TARGETS` whose class names appear nowhere
in the 1.2.99.317 bundle (Encore `e-10451-*` classes, renamed modals,
Marketplace) are deleted; the rest exist in the bundle and may match on a view
that was not measured, so they stay.

### Why the glass is not a WebGL canvas

The first GL attempt (`liquify-glass-gl.js`, deleted; see git history) moved
the background onto a WebGL canvas with a drifting texture read. It was
correct and gained nothing measurable: 70-76% GPU either way over two paired
runs of six interleaved cycles. The expensive thing was never producing the
background; it was that a background changing every frame invalidates every
`backdrop-filter` surface above it. Moving the glass to the GPU as well cannot
work, because a WebGL canvas cannot sample DOM pixels: panels over track lists
and grids would refract only the album art. The shader background in
`liquify-fabric-bg.js` works because the canvas is ordinary page content at the
bottom of the stack, so the remaining `backdrop-filter`s sample it like any
other layer, and its glass pass covers only the three chrome containers that
have nothing but background behind them.

### Mirror frame API

`liquify-fabric-bg.js` can hand its background to another local app, frame by
frame, as finished pixels. The consumer renders nothing: it gets the wall **as
the user sees it** -- warped cover, crossfade, CSS blur and dim (blur halved
under perf mode) -- minus the per-panel glass. AeriaLite uses this to put the
background on the macOS desktop, but any local process can consume it.

This section is the one definition of the protocol. AeriaLite's
`src/wallpaper-extension/LiquifyMirror.swift` implements the consumer and
points here.

The page is the **client**. It connects to `ws://127.0.0.1:47823/liquify` at
boot and retries every 3 s forever, so a consumer only has to listen. Nothing
beyond the socket is allocated until the first `hello`. AeriaLite listens only
while its menu app runs; otherwise the retries fail quietly.

Consumer -> page (text JSON):

| message | effect |
|---|---|
| `{"type":"hello","v":1,"width":W,"height":H,"blur":b,"distortion":d,"speed":s}` | W,H = target display size in **points**. `blur`/`distortion`/`speed` are optional multipliers (0–10, default 1) on the matching settings, applied to the consumer's frames only. Page replies with `info`. May be re-sent to change size or multipliers. |
| `{"type":"pull"}` | Page renders one frame immediately and sends it as one binary message. Works while Spotify is hidden (rAF does not, message events do). The consumer paces: keep one pull in flight. |

Page -> consumer:

- **text** `{"type":"info","v":1,"res":4,"dim":0.45,"fps":N,"cfg":{...},"art":url,"held":bool,"ready":bool}`
  -- after every hello, and again whenever any field changes (checked every 2 s).
- **binary** frame: a 32-byte little-endian header, then pixels.

| offset | type | field |
|---|---|---|
| 0 | 4 bytes | ASCII `LQXF` |
| 4 | u16 | version = 1 |
| 6 | u16 | flags: bit0 crossfading, bit1 empty (no art or distortion 0; width = height = 0, no payload) |
| 8 | u32 | width (px) |
| 12 | u32 | height (px) |
| 16 | u32 | seq, +1 per frame sent |
| 20 | u32 | fps the page wants to be pulled at right now: 60 while crossfading, else the Frame rate setting |
| 24 | f64 | `performance.now()`, ms |
| 32 | bytes | width x height x 4 RGBA8, top-down rows, sRGB, straight alpha (opaque) |

Frames are at the background's own quarter resolution:
`round(W/4) x round(H/4)` for a hello of W x H points. Scale them up to the
display; under that much blur the difference cannot be seen, and it is what
Spotify's own window shows. Rendering depends only on the hello size, never
on the Spotify window.

The crossfade between covers is timed by the clock, not counted in frames, so
it runs at the same speed whether the frames are going to Spotify's window, to
a consumer, or to both. `window.liquifyFabric.mirror()` in the devtools
console shows connection state, the hello size, frames sent and the last frame
size.

### Keyboard

`liquify-keys.js`. Press **`alt+/`** for the full list. Notable:

| chord | action |
|---|---|
| `alt+,` | toggle Liquify settings |
| `alt+shift+p` | perf mode (drops the filter chain, keeps a plain blur) |
| `alt+t` | Name That Tune |
| `alt+l` | toggle lyrics |
| `alt+b` / `alt+shift+b` | left / right sidebar |

Bindings match on `e.code`, not `e.key`: macOS composes Alt as a dead key, so
`alt+,` arrives as `key: "\u2264"` while `code` stays `Comma`.

### Settings

Eight rows that drove the deleted background engine or duplicated a control
this fork added are pruned, and the fabric sliders are nested into the theme's
own Background section rather than sitting above it as a second block with the
same heading.

Pruning has to be done with a stylesheet, not the `hidden` attribute:
`[hidden] { display: none }` is a UA rule and the theme's
`.liquifyRow { display: flex }` is an author rule, so it wins. Setting
`el.hidden` and reading it back reports success and hides nothing.

### Playlist header metadata row

Three separate causes made that one line look wrong, and only one of them was
Spotify's:

The doubled bullet is Spotify's. It draws the separator before the song count
twice -- once as a real `.main-entityHeader-divider` span, once as a `::before`
on the count itself -- so a snippet written against spans alone cannot see the
duplicate. The first version of `fix-duplicate-metadata-dots` was exactly that
snippet, and what its `span + span` actually matched was the save count, whose
previous sibling happens to be a divider. It read as a fix only because hiding
the saves also hid every divider after it.

The bite out of the owner's avatar is ours. Spotify clips each collaborator
face with a crescent notch (`clip-path: url(#avatarClipPath)`) so the face
behind it reads as a gap rather than a seam -- and the thing this one was
notched around is the invite-collaborators button that
`hide-sort-and-collaborator` removes. With nothing behind it the notch just
carves a sliver off the left edge, so that snippet now drops the clip too.

`3 hr 19 min` -> `3hr 19min` is in `liquify-ui-tweaks.js` rather than a snippet
because CSS cannot reach inside a string and no formatter setting produces it
either: Spotify builds the duration with Intl unit formatting, whose styles are
`short` (`3 hr, 19 min`) and `narrow` (`3h 19m`). Keeping the words while
dropping the space in front of them is not a locale that exists.

### Install

Run `./install.sh`. Tested against Spicetify 2.45.0 and Spotify 1.2.99.317.
`spicetify restore` puts Spotify back to stock.

Every run also re-asserts four standing pins that outlive this repo, which is
the answer to "why won't Spotify update":

| pin | undo |
|---|---|
| `~/Library/Application Support/Spotify/PersistentCache/Update` replaced by an immutable (`uchg`) mode-000 file, so Spotify cannot stage an update | `chflags nouchg` that path, then delete it |
| `spicetify spotify-updates block` | `spicetify spotify-updates unblock` |
| `spicetify config check_spicetify_update 0` | `spicetify config check_spicetify_update 1` |
| `brew pin spicetify-cli` | `brew unpin spicetify-cli` |
