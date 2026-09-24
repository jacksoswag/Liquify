Third-party extensions vendored so they install from disk via install.sh
instead of Spicetify Marketplace (whose installs live in Spotify's browser
storage and were wiped by a Spotify update on 2026-09-14).

- liquid-lyrics.js — NMWplays/Liquid-Lyrics, fetched from
  https://nmwplays.github.io/Liquid-Lyrics/liquid-lyrics.js (the URL the
  Marketplace manifest points at). Re-fetch to update.
- name-that-tune/ — theRealPadster/name-that-tune (GPL-3.0), the `dist` branch
  (https://github.com/theRealPadster/name-that-tune/tree/dist), copied from
  the 2026-09-09 install; `liquify-ntt-modes.js` configures it. install.sh
  copies it to CustomApps/ and makes it the only custom app. Re-fetch `dist`
  to update.
