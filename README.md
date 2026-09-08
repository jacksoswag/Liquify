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

GPU optimization of Liquify's liquid-glass rendering, plus a repair for the
Liquid Lyrics main-panel desync.

### Measurement method (read this before trusting any number)

Two confounds invalidate naive benchmarking of this app, and both produced
badly wrong numbers here before they were found:

1. **Occlusion.** Spotify's GPU use is ~0% while the window is not composited
   and 70-85% while it is. Any average that mixes hidden and visible samples is
   meaningless. Samples are now discarded unless `visibilityState === 'visible'`
   and playback is running.
2. **Baseline drift.** The baseline moves ~11 points as tracks change (album
   art, lyric density, canvas content), which swamps sequential block
   comparisons -- at one point "all glass off" measured *higher* than "with
   glass". Configs are therefore **interleaved** and compared per-cycle.

Also note `Page.setWebLifecycleState('active')` pins the GPU near 80% on an
occluded window, so it must never be used while measuring.

Numbers below are medians of 7 interleaved cycles, playing music with the
lyrics view open, at 1267x924.

| configuration | GPU (median) | range |
|---|---|---|
| stock Liquify | **80.9%** | 80.1-82.1 |
| this fork, look identical | **75.5%** | 72-78.1 |
| this fork + single-pass glass | **63.3%** | 60.1-68.3 |
| *all glass removed entirely* | *62.9%* | 59.8-69.8 |
| *all theme CSS stripped (~vanilla)* | *0.8%* | 0.2-3.5 |

### What this means

**The warping glass is not the problem.** Single-pass displacement lands within
0.4 points of removing every `backdrop-filter` in the app, so refraction is
essentially free. It is the **3-pass chromatic aberration chain** that costs
~12 points (`feImage` -> 3x `feDisplacementMap` -> 3x `feColorMatrix` ->
2x `feBlend`), and the per-element filter graphs that made it worse.

**The remaining ~63% is the theme's aggregate paint/layer structure**, not any
single property. Measured against a no-glass baseline: `box-shadow` ~6 points,
`text-shadow` ~3, `mix-blend-mode` ~1. The rest is not attributable to one
declaration -- only stripping the theme wholesale reaches vanilla's 0.8%.

**The <25% target was not reached and is not reachable while keeping this
theme's appearance.** Reporting that plainly rather than quoting a figure from
a contaminated run.

### What this fork changes

- **Shared filter graphs.** Stock Liquify builds one `liquify-filter-N` per
  glass surface (86 selectors, 15 live graphs on one view). Collapsed to two.
- **Raster displacement map.** `feImage` pointed at an SVG data-URI that Skia
  re-rasterizes *inside the filter graph* on every `ResizeObserver` fire; now a
  canvas-rendered PNG.
- **Dead backdrop elimination.** 115 of 137 glass surfaces were doing nothing:
  96 zero-area/offscreen, 12 at `opacity:0`, and 7 running `blur(0px)` -- a
  zero-radius blur is a visual no-op but still allocates a backdrop render
  surface. Two of those were 657,661 px and 371,520 px. Backdrop-filtered area:
  **1,532,015 -> 454,294 px**.
- **Low-resolution album background.** `.liquify-bg-layer` renders into a
  1/4-linear box scaled back up, blur radius divided to match:
  **1,170,708 -> 73,227 px** of backing store per layer, visually identical.
- **Liquid Lyrics desync repair.** See `liquify-ui-tweaks.js`.
- **`cmd+P`** toggles perf mode; state persists.

### Install

Copy `liquify-perf.js` and `liquify-ui-tweaks.js` into your Spicetify
`Extensions/` folder, then:

```
spicetify config extensions liquify-perf.js|liquify-ui-tweaks.js
spicetify apply
```

Snippets live in `snippets/` and can be pasted into Spicetify Marketplace
individually.
