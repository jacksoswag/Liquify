<h1 align="center"> ✨ Liquify Theme Spicetify ✨ </h1>

<p align="center">
  <b>A modern, rounded and liquified theme for spicetify</b><br>
</p>

## Contents

<!-- toc -->

- [Introduction](#introduction)
- [Theme screenshots](#theme-screenshots)
- [Features](#features)
<!-- tocstop -->

## Introduction

**Liquify** - is a glassmorphic Spicetify theme for Spotify featuring a modern, luminous interface and smooth animations.

Liquify is inspired by [Glassify](https://github.com/sanoojes/spicetify-glassify) from [Sanoojes](https://github.com/sanoojes).

If your transparent controls don’t look fully transparent — for example when zooming in on Spotify — you can easily change the width and height of them in the Glowify Settings to make them fully transparent again.

If you like the theme, consider starring the repository on GitHub! ⭐

**For support join the Discord!**:

<a href="https://discord.gg/QRMnrgjhvq" target="_blank">
  <img src="discord-icon.png" alt="Discord-server-link" width="64" />
</a>

## Theme screenshots

<details>
<summary>Click to watch screenshots</summary>
<img width="1919" height="1029" alt="Homescreen" src="https://github.com/user-attachments/assets/a7d50e6e-56be-4a8b-8ea6-8835655d4cdf" />

<img width="1919" height="1029" alt="Playlist" src="https://github.com/user-attachments/assets/5375a463-10a4-428e-8e5c-f43d76e03509" />

<img width="1919" height="1030" alt="Search" src="https://github.com/user-attachments/assets/71d1c7a5-bca6-47d3-880c-8c0e85c45bce" />

<img width="1919" height="1030" alt="Artist-Page" src="https://github.com/user-attachments/assets/60151e06-8a6a-4548-a882-1c267c18e7ca" />

<img width="1919" height="1028" alt="Artist-Page2" src="https://github.com/user-attachments/assets/fa9bdb4f-666e-4380-9ee3-2da6b33be730" />

<img width="1919" height="1030" alt="Liquify-Settings" src="https://github.com/user-attachments/assets/0ab96146-4868-468c-8a22-7cb03fa992c1" />

<img width="1919" height="1030" alt="Popup" src="https://github.com/user-attachments/assets/59b2f2e9-b273-4f2a-9d06-7e562be21f8d" />

<img width="1919" height="1029" alt="Settings" src="https://github.com/user-attachments/assets/f37cfbef-7d3e-4ed4-bab5-0dfeae4362aa" />

<img width="1919" height="1030" alt="Fullscreen" src="https://github.com/user-attachments/assets/7b147a4f-6f48-4123-bf65-96b4a94d44e0" />

</details>

---

## Features

**Liquify offers:**

- Many customization options
-  `Beatiful Lyrics`, `Spicy Lyrics` and `Lucid Lyrics` are supported by default
- Beautiful dynamic colors (Just enable dynamic button colors in the settings and your good to go)
- Modern, rounded UI
- And much more!

## Credits

Created by NMW.

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See the LICENSE file for details.

---

## Performance fork (`perf` branch)

A rewrite of how Liquify draws its liquid glass, plus a keyboard layer, a
Name That Tune game and a settings cleanup. Five extensions:

| file | what it does |
|---|---|
| `liquify-fabric-bg.js` | the background, as a WebGL fragment shader, and the panel glass |
| `liquify-perf.js` | the shared SVG glass filter, shadow rules, the fabric sliders |
| `liquify-keys.js` | keyboard control (`alt+/` lists every binding) |
| `liquify-ui-tweaks.js` | settings merge and pruning, Liquid Lyrics desync repair |
| `liquify-ntt-modes.js` | source, difficulty and round settings for Name That Tune |

Two more files in the repo are **not** loaded and are kept on purpose, so they
are not leftovers to tidy away: `liquify-glass-gl.js` is the superseded first
attempt at a GL background, kept because the note at the top of it explains why
a WebGL canvas cannot stand in for glass that sits over live content, and
`liquify-fabric-bg.js` cites it. `liquify-home-apps.js` renders custom apps as
Home sections; the hard half works and its header documents the half that does
not.

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

Worth knowing if you touch the selector list: the theme ships 89 glass
selectors and **80 of them match nothing** on Spotify 1.2.99. They are hashed
class names from an older build. That, not the filter, is why the glass appears
on so little.

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

### Install

```
cp liquify-*.js "$(spicetify path userdata)/Extensions/"
spicetify config extensions liquify-perf.js|liquify-ui-tweaks.js|liquify-keys.js|liquify-fabric-bg.js|liquify-ntt-modes.js
spicetify apply
```

Snippets live in `snippets/` and can be pasted into Spicetify Marketplace
individually. Tested against Spicetify 2.45.0 and Spotify 1.2.99.
