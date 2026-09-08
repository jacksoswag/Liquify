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

GPU optimization of Liquify's liquid-glass rendering. Measured on Spotify
1.2.99 / Chromium 146 at 1610x1011 (dpr 1.83), scrolling driven through the
page's own scroll container, GPU sampled from IOAccelerator
`Device Utilization %`, with A/B/A drift checks bracketing every run:

| configuration | GPU (scrolling) | GPU (idle) |
|---|---|---|
| stock Liquify + Rotating Cover Art | **83.0% – 84.7%** (peaks 100%) | ~78% |
| this fork | **16.3% – 16.5%** (peaks 18%) | **0.1%** |
| this fork + perf mode (`cmd+P`) | **13.9%** (peaks 16%) | 0.1% |

The glass look is unchanged: same displacement refraction, same chromatic
aberration, same blur. No fallback to plain blur outside perf mode.

### What was costing the GPU

**1. A continuously animating element behind the glass (~80% of the problem).**
The community *Rotating Cover Art* snippet applies `animation` to `.cover-art`
globally. Only three elements match, but they are not equal:

| spinning element | GPU |
|---|---|
| 110px playbar disc | **78%** |
| 434px Now Playing cover | 16.7% (free) |
| 68px mini cover | 16.7% (free) |

Any running animation behind a glass surface makes Chromium recompute *every*
`backdrop-filter` surface in the window (~41 of them) each frame — the
invalidation is not scoped to the damage rect. Quantizing the animation does
not help (`steps(300)` 77.6%, `steps(200)` 75.0%, `steps(120)` 81.2%), so it is
the presence of a running animation rather than its frequency; `contain` and
`will-change` do not help either. `snippets/rotating-cover-art-optimized.css`
therefore spins only the Now Playing cover, which is free.

Evidence this was the felt lag: the scroll loop completed **309 ticks/8s**
stock versus **566** optimized — the GPU was starving the scroller itself.

**2. One SVG filter graph per glass surface.** Liquify builds a
`liquify-filter-N` per element (86 selectors, 15 live graphs on a single view),
each a 9-primitive chain whose `feImage` points at an **SVG data-URI that Skia
re-rasterizes inside the filter graph** on every `ResizeObserver` fire.
`liquify-perf.js` collapses these into two shared graphs — chromatic for large
surfaces, single-pass for small controls where the RGB fringe is sub-pixel —
backed by a canvas-rasterized PNG map. Worth **2.3x per-frame GPU** on its own
(22.8 -> 9.8 GPU-ms/frame), though masked while cause 1 dominates.

### Install

Copy `liquify-perf.js` and `liquify-ui-tweaks.js` into your Spicetify
`Extensions/` folder, then:

```
spicetify config extensions liquify-perf.js|liquify-ui-tweaks.js
spicetify apply
```

`cmd+P` (`ctrl+P` on Windows/Linux) toggles perf mode; the state persists.

Snippets live in `snippets/` and can be pasted into Spicetify Marketplace
individually.
