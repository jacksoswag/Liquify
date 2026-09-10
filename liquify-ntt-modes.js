// liquify-ntt-modes — where Name That Tune gets its songs from, and how hard.
//
// The game itself has no notion of a source: it plays whatever is already in
// the queue, and its only other input is a URI list handed to it through
//
//     History.push({ pathname: '/name-that-tune', search: '?t=' + Date.now(),
//                    state: { URIs: [...] } })
//
// which is how its context-menu entry works. That contract is the whole
// integration here. Nothing in the app is patched: this builds a track list and
// hands it over the same way, so the game keeps running its own round logic.
//
// WHERE THE DATA COMES FROM, and why not the obvious place.
//
// The obvious place is the Spotify Web API, and it is closed. Measured against
// the registered app on this machine:
//
//     /v1/search           429  QUOTA_EXCEEDED
//     /v1/tracks?ids=      403  Forbidden
//     /v1/artists/*/top-tracks  403  Forbidden
//     /v1/recommendations  404  (withdrawn for apps without extended quota)
//
// Only /v1/me/* still answers. So everything below goes through the internal
// GraphQL API the client uses for its own UI -- no registered app, no token to
// store, no shared proxy, and no quota that browsing Spotify normally would not
// already spend.
//
// It also turns out to be the better data. `queryAlbumTracks` returns a
// `playcount` per track -- real all-time streams -- which is a far sharper
// difficulty signal than the Web API's 0-100 `popularity`, a figure that is
// recency-weighted and flattens everything below the mainstream into a smear.
//
// DIFFICULTY is therefore a floor on playcount, and the bands are cumulative
// exactly as they were asked for: medium is "semi-popular AND popular", so it
// is one floor, not a window. A window would make the middle difficulties
// weirder than the extremes -- excluding the hits you would actually recognise.
//
// COST. Every mode resolves to a handful of album queries and stops: the whole
// point of playcount is that one query decorates a dozen tracks at once, so a
// game is set up in well under twenty requests rather than one per track.

(function liquifyNttModes() {
  if (typeof window.Spicetify?.GraphQL?.Request !== 'function' ||
      !window.Spicetify?.GraphQL?.Definitions?.queryAlbumTracks ||
      !window.Spicetify?.Platform?.History || !document.body) {
    return setTimeout(liquifyNttModes, 400);
  }

  // Resolved per call, never captured. Spicetify replaces the whole GraphQL
  // object once its real client is up, so an alias taken at extension load time
  // keeps pointing at the early stub -- which has Definitions on it but no
  // Request, and fails with "GQL.Request is not a function" only once a game is
  // actually started.
  const req = (name, vars) => Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions[name], vars);

  const SRC_KEY = 'liquify-ntt-source';
  const DIFF_KEY = 'liquify-ntt-difficulty';
  const ARG_KEY = 'liquify-ntt-arg';
  const ARG_URI_KEY = 'liquify-ntt-arg-uri';

  // Playcount floors. Calibrated against real tracks rather than round numbers:
  // a 100M-stream song is one nearly everyone has heard, 10M is a song that
  // charted or went round somewhere, 500k is a real release with an audience
  // rather than an upload. Below that is where unnameable filler lives, which
  // is what "impossible" is for.
  const BANDS = {
    easy: 100e6,
    medium: 10e6,
    hard: 500e3,
    impossible: 0,
  };

  const LABELS = {
    library: 'Your library',
    artist: 'Artist',
    genre: 'Genre',
    all: 'All Spotify',
  };

  const TARGET = 60;              // tracks handed to the game; it shuffles them
  // Ceiling on album queries per game, whatever the mode. Measured: ~120ms
  // each, and a run stops as soon as it has enough, so this is the worst case
  // (about three seconds) rather than the usual one. Set from what the bands
  // actually yield -- at 14 a hard-difficulty genre came back with nine songs.
  const MAX_ALBUM_QUERIES = 24;

  const cfg = () => ({
    source: localStorage.getItem(SRC_KEY) || 'library',
    difficulty: localStorage.getItem(DIFF_KEY) || 'medium',
    arg: localStorage.getItem(ARG_KEY) || '',
    // Set only by picking from the suggestion list, and only trusted while the
    // text still matches what was picked -- otherwise typing over a chosen
    // artist would quietly keep quizzing you on the old one.
    argUri: localStorage.getItem(ARG_URI_KEY) || '',
  });

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const uniq = (a) => [...new Set(a)];

  // ---- internal API wrappers -------------------------------------------------

  // Spotify's OWN search queries, lifted verbatim off the wire.
  //
  // Spicetify.GraphQL.Definitions only exposes a subset, and the mixed-results
  // search in it is the wrong tool for picking an artist: it returns one ranked
  // list of every entity type competing for the same slots, so "daft" came back
  // with exactly one artist and everything else was Daft Punk's tracks and
  // albums. That is a confirmation of the top hit, not an artist picker.
  //
  // The client's own Artists tab uses a persisted query called searchArtists,
  // and Definitions does not carry it. Its hash and its full variable set were
  // read off the request Spotify itself makes when you open
  // /search/<term>/artists -- which is why the suggestions here are the same
  // list, in the same order, that Spotify's search would show you.
  //
  // A persisted hash belongs to a client build, so a Spotify update can retire
  // one. Every call through here falls back to the mixed search in Definitions
  // if that happens: the list gets thinner, nothing breaks, and the fix is to
  // re-read the hash from the network tab.
  const PERSISTED = {
    searchArtists: {
      name: 'searchArtists', operation: 'query', value: null,
      sha256Hash: '270905851ba5c7faca81cfe053c2dbd8ceb4f156a0e0ef4b385af75ab69ffd13',
    },
    searchTopResultsList: {
      name: 'searchTopResultsList', operation: 'query', value: null,
      sha256Hash: '337d8b1b4f911fb12c60996623391703c2807550baccb51d95f5eabc8c8bdacd',
    },
  };

  // The search the search modal uses. Every one of these variables is required;
  // omit any and the call comes back HttpResponseError with nothing to say
  // about which. Results arrive as one ranked list of mixed entity types under
  // topResultsV2, not as per-type sections, so callers filter by __typename.
  async function searchTop(term, limit = 10) {
    const r = await req('searchModalResults', {
      searchTerm: term,
      offset: 0,
      limit,
      numberOfTopResults: limit,
      includeAudiobooks: true,
      includeArtistHasConcertsField: false,
      includePreReleases: false,
      includeLocalConcertsField: false,
      includeAuthors: false,
    });
    return (r?.data?.searchV2?.topResultsV2?.itemsV2 || [])
      .map((i) => i.item?.data)
      .filter(Boolean);
  }

  // An Artist entity carries its name under `profile`, not at the top level
  // like every other type here.
  const artistName = (d) => d?.profile?.name || d?.name || '';

  // Every artist on Spotify, ranked the way Spotify ranks them: 30 per query,
  // with the avatar the client shows. "daft" gives Daft Punk, Gorillaz,
  // Pharrell, Justice...; "the b" gives The Beatles, The Buggles, The Beach
  // Boys...; a bare "x" gives XXXTENTACION, X, Juice WRLD, Charli xcx.
  async function searchArtists(term, n = 8) {
    try {
      const r = await Spicetify.GraphQL.Request(PERSISTED.searchArtists, {
        searchTerm: term, offset: 0, limit: 30, numberOfTopResults: 20,
        includePreReleases: false, includeAlbumPreReleases: false,
        includeAudiobooks: true, includeAuthors: true, includeEpisodeContentRatingsV2: true,
      });
      const items = r?.data?.searchV2?.artists?.items || [];
      if (items.length) {
        return items.slice(0, n).map((i) => ({
          __typename: 'Artist',
          uri: i.data?.uri,
          profile: i.data?.profile,
          image: i.data?.visuals?.avatarImage?.sources?.slice(-1)[0]?.url
              || i.data?.visuals?.avatarImage?.sources?.[0]?.url || '',
        })).filter((a) => a.uri);
      }
    } catch { /* hash retired by a client update -- fall through */ }
    return (await searchTop(term, 40)).filter((d) => d.__typename === 'Artist').slice(0, n);
  }

  // Albums and singles both count: a single is often where the one track people
  // know actually lives, and excluding them would quietly remove most of what
  // "easy" means for recent artists.
  async function artistAlbums(artistUri, n = 8) {
    const r = await req('queryArtistDiscographyAll', { uri: artistUri, offset: 0, limit: 40 });
    const items = r?.data?.artistUnion?.discography?.all?.items || [];
    const uris = items
      .map((i) => i.releases?.items?.[0]?.uri)
      .filter(Boolean);
    return shuffle(uniq(uris)).slice(0, n);
  }

  // The one call that carries playcount, and the reason the whole design is
  // album-shaped: a single request decorates every track on the record.
  async function albumTracks(albumUri) {
    const r = await req('queryAlbumTracks', { uri: albumUri, offset: 0, limit: 60 });
    const items = r?.data?.albumUnion?.tracksV2?.items || r?.data?.albumUnion?.tracks?.items || [];
    return items
      .map((i) => i.track)
      .filter((t) => t?.uri && t.playability?.playable !== false)
      .map((t) => ({ uri: t.uri, name: t.name, plays: Number(t.playcount) || 0 }));
  }

  // Walks albums until it has enough tracks or runs out of budget. The budget is
  // the point: without it "All Spotify" would happily issue a request per album
  // of every artist it found.
  async function tracksFromAlbums(albumUris, floor, want) {
    const out = [];
    let queries = 0;
    for (const uri of albumUris) {
      if (queries >= MAX_ALBUM_QUERIES || out.length >= want) break;
      queries++;
      try {
        for (const t of await albumTracks(uri)) if (t.plays >= floor) out.push(t);
      } catch { /* a single unavailable album is not worth failing the game for */ }
    }
    return out;
  }

  // ---- sources ---------------------------------------------------------------

  // Saved tracks, with playcount fetched by way of the albums they sit on --
  // the library API itself does not carry one. Only tracks you actually saved
  // survive the intersection: an album query returns the whole record, and
  // quizzing you on the other nine tracks would not be your library.
  async function fromLibrary(floor) {
    const page = await Spicetify.Platform.LibraryAPI.getTracks({ limit: 400, offset: 0 });
    const saved = (page?.items || []).filter((t) => t.uri && !t.isLocal);
    if (!saved.length) return [];
    const savedUris = new Set(saved.map((t) => t.uri));

    // Ordered by how many saved tracks each album accounts for, because every
    // album costs one query however much it returns: a record you saved six
    // tracks from is six times the yield of one you saved a single track from.
    // Shuffled within equal counts so the same records are not always first.
    const perAlbum = new Map();
    for (const t of saved) {
      const a = t.album?.uri;
      if (a) perAlbum.set(a, (perAlbum.get(a) || 0) + 1);
    }
    const albums = shuffle([...perAlbum.entries()])
      .sort((x, y) => y[1] - x[1])
      .map(([uri]) => uri);

    const decorated = await tracksFromAlbums(albums, floor, TARGET * 2);
    const mine = decorated.filter((t) => savedUris.has(t.uri));

    // Below "hard" the floor stops doing anything useful for a personal library
    // -- most of what people save has few enough streams that the band would
    // empty -- so an empty result falls back to the library unfiltered rather
    // than refusing to start.
    return mine.length >= 8 ? mine : saved.map((t) => ({ uri: t.uri, name: t.name, plays: 0 }));
  }

  async function fromArtist(name, floor, uri) {
    let artistUri = uri;
    if (!artistUri) {
      const [artist] = await searchArtists(name, 1);
      if (!artist) throw new Error(`No artist found for "${name}"`);
      artistUri = artist.uri;
    }
    const albums = await artistAlbums(artistUri, MAX_ALBUM_QUERIES);
    return tracksFromAlbums(albums, floor, TARGET);
  }

  // A genre is not a thing you can list tracks from, so it is resolved the way
  // a person would: find artists for it, then take their records. Two albums
  // per artist keeps one prolific act from becoming the whole quiz.
  async function fromGenre(name, floor) {
    const artists = await searchArtists(name, 8);
    if (!artists.length) throw new Error(`No artists found for "${name}"`);
    const albums = [];
    for (const a of artists) {
      try { albums.push(...(await artistAlbums(a.uri, 3))); } catch {}
    }
    return tracksFromAlbums(shuffle(albums), floor, TARGET);
  }

  // "All Spotify" has no listing endpoint either. Random two-letter seeds are
  // the old trick for reaching arbitrary catalogue through a search box, and
  // they work here because the difficulty floor does the quality control
  // afterwards -- the seed only has to be arbitrary, not good.
  const SEEDS = 'abcdefghijklmnopqrstuvwxyz';
  const randomSeed = () =>
    SEEDS[Math.floor(Math.random() * 26)] + SEEDS[Math.floor(Math.random() * 26)];

  async function fromAll(floor) {
    const albums = [];
    for (let i = 0; i < 4 && albums.length < MAX_ALBUM_QUERIES; i++) {
      try {
        const artists = await searchArtists(randomSeed(), 4);
        for (const a of artists) albums.push(...(await artistAlbums(a.uri, 2)));
      } catch {}
    }
    return tracksFromAlbums(shuffle(albums), floor, TARGET);
  }

  async function buildQueue({ source, difficulty, arg, argUri }) {
    const floor = BANDS[difficulty] ?? 0;
    if (source === 'artist') return fromArtist(arg, floor, argUri);
    if (source === 'genre') return fromGenre(arg, floor);
    if (source === 'all') return fromAll(floor);
    return fromLibrary(floor);
  }

  // ---- handing the game its songs -------------------------------------------

  async function startGame() {
    const c = cfg();
    if ((c.source === 'artist' || c.source === 'genre') && !c.arg.trim()) {
      Spicetify.showNotification(`Enter ${c.source === 'artist' ? 'an artist' : 'a genre'} first`, true);
      return;
    }
    setBusy(true);
    try {
      const tracks = await buildQueue(c);
      if (!tracks.length) {
        // Harder means a LOWER playcount floor, so an empty easy round is
        // fixed by going harder, not easier. Worth stating in the message:
        // the instinct on an empty result is to reach the other way.
        Spicetify.showNotification(
          `Nothing that popular in ${LABELS[c.source].toLowerCase()} — try a harder difficulty`, true);
        return;
      }
      const uris = shuffle(uniq(tracks.map((t) => t.uri))).slice(0, TARGET);
      // The app's own contract, unchanged: it expands, shuffles and plays what
      // arrives in state.URIs, and the timestamp is what makes an identical
      // route a new game rather than a no-op.
      Spicetify.Platform.History.push({
        pathname: '/name-that-tune',
        search: `?t=${Date.now()}`,
        state: { URIs: uris },
      });
      Spicetify.showNotification(`${uris.length} songs — ${LABELS[c.source]}, ${c.difficulty}`);
    } catch (e) {
      Spicetify.showNotification(String(e?.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  // ---- the bar ---------------------------------------------------------------
  //
  // Fixed, and never a child of anything the game renders. The whole main view
  // belongs to React, and appending into a React-owned parent is what broke the
  // home page the last time something was injected there -- reconciliation and
  // a stray DOM node do not coexist. So this floats over the page and is
  // positioned from the main view's own rectangle.

  const style = document.createElement('style');
  style.id = 'lqx-ntt-modes-style';
  style.textContent = `
    #lqx-ntt-bar{position:fixed;z-index:5;display:none;align-items:center;gap:8px;
      padding:8px 10px;border-radius:14px;
      background:color-mix(in srgb,var(--spice-main) 62%,transparent);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.10),0 12px 30px rgba(0,0,0,.35);
      backdrop-filter:blur(22px);font:inherit}
    body.name-that-tune #lqx-ntt-bar{display:flex}
    #lqx-ntt-bar select,#lqx-ntt-bar input{appearance:none;border:0;border-radius:9px;
      padding:7px 10px;font:inherit;font-size:12px;color:var(--spice-text);
      background:rgba(255,255,255,.09)}
    #lqx-ntt-bar select:hover,#lqx-ntt-bar input:hover{background:rgba(255,255,255,.14)}
    #lqx-ntt-bar input{width:150px}
    #lqx-ntt-bar input::placeholder{color:var(--spice-subtext)}
    #lqx-ntt-bar button{appearance:none;border:0;cursor:pointer;border-radius:999px;
      padding:7px 16px;font:inherit;font-size:12px;font-weight:700;
      color:var(--spice-main);background:var(--spice-button)}
    #lqx-ntt-bar button:disabled{opacity:.55;cursor:progress}
    #lqx-ntt-bar[data-arg="hide"] input{display:none}
    #lqx-ntt-argwrap{position:relative;display:flex}
    #lqx-ntt-bar[data-arg="hide"] #lqx-ntt-argwrap{display:none}
    /* Opens upward: this bar sits at the bottom of the view, so a list hanging
       below it would be off-screen. */
    #lqx-ntt-sugg{position:absolute;bottom:calc(100% + 6px);left:0;z-index:1;
      display:none;flex-direction:column;width:230px;max-height:260px;overflow-y:auto;
      overscroll-behavior:contain;padding:4px;border-radius:11px;
      background:color-mix(in srgb,var(--spice-main) 94%,transparent);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 14px 34px rgba(0,0,0,.45);
      backdrop-filter:blur(22px)}
    #lqx-ntt-sugg[data-open="1"]{display:flex}
    #lqx-ntt-sugg button{display:block;width:100%;text-align:left;border-radius:7px;
      padding:7px 9px;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;
      text-overflow:ellipsis;color:var(--spice-text);background:transparent}
    #lqx-ntt-sugg button{display:flex;align-items:center;gap:8px}
    #lqx-ntt-sugg button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #lqx-ntt-sugg img{flex:0 0 auto;width:26px;height:26px;border-radius:50%;object-fit:cover}
    #lqx-ntt-sugg button:hover,#lqx-ntt-sugg button[data-on="1"]{background:rgba(255,255,255,.14)}

    /* The play bar goes for the whole of the game, not just while a round is
       being guessed. The game hides its left-hand side itself -- cover, title,
       artist -- but leaves the transport, the scrubber and the track time
       sitting under the guess box, where they are no use (the game has its own
       Play 1s) and where this bar would otherwise land on top of them.
       Route-wide rather than round-wide so it does not slide back in and out
       between every reveal and the next song.

       The slide, the timing and the extra 24px that carries the floating
       player's shadow out with it are liquify-keys' -- the transition it
       installs lives on the bar unconditionally, so this animates on the way in
       as well. The html-body prefix is there for the same reason it is there: the
       Dynamic Search Bar snippet sets transform:none !important on both of
       these selectors, and this has to outrank it. */
    html body.name-that-tune .Root__now-playing-bar,
    html body.name-that-tune aside[aria-label="Now playing bar"]{
      transform:translateY(calc(100% + 24px))!important;opacity:0!important;
      visibility:hidden!important;pointer-events:none!important;
      transition:transform .34s cubic-bezier(.32,.72,0,1),opacity .26s ease,visibility 0s linear .34s}`;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'lqx-ntt-bar';
  bar.innerHTML = `
    <select id="lqx-ntt-source" aria-label="Song source">
      <option value="library">Your library</option>
      <option value="artist">Artist</option>
      <option value="genre">Genre</option>
      <option value="all">All Spotify</option>
    </select>
    <span id="lqx-ntt-argwrap">
      <input id="lqx-ntt-arg" type="text" spellcheck="false" autocomplete="off" placeholder="name">
      <span id="lqx-ntt-sugg" role="listbox"></span>
    </span>
    <select id="lqx-ntt-diff" aria-label="Difficulty">
      <option value="easy">Easy</option>
      <option value="medium">Medium</option>
      <option value="hard">Hard</option>
      <option value="impossible">Impossible</option>
    </select>
    <button id="lqx-ntt-go" type="button">New game</button>`;
  document.body.appendChild(bar);

  const $src = bar.querySelector('#lqx-ntt-source');
  const $arg = bar.querySelector('#lqx-ntt-arg');
  const $diff = bar.querySelector('#lqx-ntt-diff');
  const $go = bar.querySelector('#lqx-ntt-go');
  const $sugg = bar.querySelector('#lqx-ntt-sugg');

  const setBusy = (b) => {
    $go.disabled = b;
    $go.textContent = b ? 'Finding songs…' : 'New game';
  };

  function syncArgVisibility() {
    const needsArg = $src.value === 'artist' || $src.value === 'genre';
    bar.dataset.arg = needsArg ? 'show' : 'hide';
    $arg.placeholder = $src.value === 'genre' ? 'e.g. shoegaze' : 'e.g. Daft Punk';
  }

  const c0 = cfg();
  $src.value = c0.source;
  $diff.value = c0.difficulty;
  $arg.value = c0.arg;
  syncArgVisibility();

  $src.addEventListener('change', () => {
    localStorage.setItem(SRC_KEY, $src.value);
    // An artist URI means nothing once the source is a genre, and vice versa.
    localStorage.removeItem(ARG_URI_KEY);
    closeSuggestions();
    syncArgVisibility();
  });
  $diff.addEventListener('change', () => localStorage.setItem(DIFF_KEY, $diff.value));
  // ---- suggestions -----------------------------------------------------------
  //
  // Artists come straight out of the same search the client's own search box
  // uses, so they are ranked the way Spotify ranks them and a two-letter stub
  // finds the obvious act.
  //
  // Genres cannot rely on that alone. Spotify does return Genre entities, but
  // only for terms it already considers a genre and mostly only once the word
  // is nearly complete: "jaz" offers Jazz, Cool jazz and Smooth Jazz, while
  // "shoe" and even the whole of "hyperpop" offer none at all. So live genre
  // hits are merged with a fixed list, which is what makes the partial-word
  // case work rather than silently returning nothing.
  const GENRES = [
    'acid jazz', 'afrobeats', 'alternative rock', 'ambient', 'americana', 'bedroom pop',
    'blues', 'bossa nova', 'breakbeat', 'britpop', 'chillwave', 'city pop', 'classical',
    'country', 'dance punk', 'dancehall', 'disco', 'drum and bass', 'dream pop', 'drill',
    'dub', 'dubstep', 'electronic', 'emo', 'folk', 'funk', 'garage rock', 'gospel',
    'grunge', 'hard rock', 'hip hop', 'house', 'hyperpop', 'indie folk', 'indie pop',
    'indie rock', 'industrial', 'jazz', 'jungle', 'k-pop', 'latin', 'lo-fi', 'math rock',
    'metal', 'motown', 'neo soul', 'new wave', 'noise rock', 'nu disco', 'opera', 'phonk',
    'pop', 'pop punk', 'post-punk', 'post-rock', 'progressive rock', 'psychedelic rock',
    'punk', 'r&b', 'reggae', 'reggaeton', 'rock', 'salsa', 'samba', 'shoegaze', 'ska',
    'slowcore', 'soul', 'soundtrack', 'synthpop', 'techno', 'trance', 'trap', 'trip hop',
    'uk garage', 'vaporwave', 'world',
  ];

  let suggestions = [];
  let cursor = -1;
  let suggestToken = 0;

  function closeSuggestions() {
    $sugg.dataset.open = '0';
    // Emptied, not just hidden: otherwise the previous query's list is what
    // flashes up for an instant the next time the box is focused.
    $sugg.textContent = '';
    suggestions = [];
    cursor = -1;
    // Nothing in flight can reopen the list after this: the token moves, and
    // every fetch checks it before rendering.
    suggestToken++;
  }

  function renderSuggestions() {
    if (!suggestions.length) return closeSuggestions();
    $sugg.textContent = '';
    suggestions.forEach((item, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.on = i === cursor ? '1' : '0';
      if (item.image) {
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = '';
        b.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = item.label;
      b.appendChild(label);
      // mousedown, not click: the input's blur would close the list first.
      b.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      $sugg.appendChild(b);
    });
    $sugg.dataset.open = '1';
  }

  function choose(i) {
    const item = suggestions[i];
    if (!item) return;
    $arg.value = item.label;
    localStorage.setItem(ARG_KEY, item.label);
    // An artist suggestion carries the exact URI, which saves resolving the
    // name again at start and removes the chance of resolving it differently.
    if (item.uri) localStorage.setItem(ARG_URI_KEY, item.uri);
    else localStorage.removeItem(ARG_URI_KEY);
    closeSuggestions();
  }

  // Genres come off the same top-results query Spotify's own search page runs,
  // which surfaces far more of them than the modal search does (17 for "jaz"
  // against six). It still misses plenty -- neither query returns a Genre for
  // "shoe", or for the whole word "hyperpop" -- which is what the fixed list
  // above is for. Live hits first, since those are Spotify's own vocabulary.
  async function searchGenres(term) {
    try {
      const r = await Spicetify.GraphQL.Request(PERSISTED.searchTopResultsList, {
        query: term, limit: 50, offset: 0, numberOfTopResults: 50,
        includeArtistHasConcertsField: false, includeAudiobooks: true, includeAuthors: true,
        includePreReleases: true, includeAlbumPreReleases: false,
        includeEpisodeContentRatingsV2: true, isPrefix: null,
        sectionFilters: ['GENERIC', 'VIDEO_CONTENT'],
      });
      return (r?.data?.searchV2?.topResultsV2?.itemsV2 || [])
        .map((i) => i.item?.data)
        .filter((d) => d?.__typename === 'Genre' && d.name)
        .map((d) => d.name);
    } catch {
      return (await searchTop(term, 40))
        .filter((d) => d.__typename === 'Genre' && d.name)
        .map((d) => d.name);
    }
  }

  async function fetchSuggestions(term) {
    const token = ++suggestToken;
    const q = term.trim();
    // One character is enough -- Spotify's own search answers "x" with
    // XXXTENTACION, X, Juice WRLD and Charli xcx, and there is no reason for
    // this box to be pickier than the one it is borrowing results from.
    if (q.length < 1) return closeSuggestions();

    let list = [];
    if ($src.value === 'genre') {
      const lower = q.toLowerCase();
      const seen = new Set();
      const add = (name) => {
        const k = name.toLowerCase();
        if (!seen.has(k)) { seen.add(k); list.push({ label: name }); }
      };
      for (const name of await searchGenres(q)) add(name);
      for (const g of GENRES) if (g.includes(lower)) add(g);
      // Names that START with what was typed are what someone means; the rest
      // stay, just after them, so "jaz" leads with Jazz rather than with
      // "Lounging with Jazz".
      list.sort((a, b) =>
        (b.label.toLowerCase().startsWith(lower) ? 1 : 0) -
        (a.label.toLowerCase().startsWith(lower) ? 1 : 0));
    } else {
      try {
        list = (await searchArtists(q, 8))
          .map((d) => ({ label: artistName(d), uri: d.uri, image: d.image || '' }))
          .filter((x) => x.label);
      } catch { list = []; }
    }

    if (token !== suggestToken) return;   // a later keystroke already won
    suggestions = list.slice(0, 8);
    cursor = -1;
    renderSuggestions();
  }

  let suggestTimer = null;
  $arg.addEventListener('input', () => {
    localStorage.setItem(ARG_KEY, $arg.value);
    // Typing over a chosen artist drops the URI that was chosen with it.
    localStorage.removeItem(ARG_URI_KEY);
    clearTimeout(suggestTimer);
    const term = $arg.value;
    suggestTimer = setTimeout(() => fetchSuggestions(term), 220);
  });

  $arg.addEventListener('focus', () => { if ($arg.value.trim()) fetchSuggestions($arg.value); });
  $arg.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

  $arg.addEventListener('keydown', (e) => {
    const open = $sugg.dataset.open === '1' && suggestions.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }
    if (e.key === 'Escape') { closeSuggestions(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Enter takes the highlighted suggestion if there is one, and otherwise
    // means "go" -- so a name typed in full never needs the list at all.
    if (open && cursor >= 0) choose(cursor);
    else { closeSuggestions(); startGame(); }
  });
  $go.addEventListener('click', startGame);

  // Typing a genre must not reach the keybinds, which are global and would read
  // a bare letter as a shortcut.
  bar.addEventListener('keydown', (e) => e.stopPropagation());

  // Anchored under the main view rather than centred on the window: the sidebar
  // and the friend feed are not the same width, so window-centred would sit
  // visibly off from the game's own column.
  function place() {
    const view = document.querySelector('.Root__main-view');
    if (!view) return;
    const r = view.getBoundingClientRect();
    bar.style.left = `${Math.round(r.left + r.width / 2)}px`;
    bar.style.transform = 'translateX(-50%)';
    bar.style.bottom = `${Math.round(window.innerHeight - r.bottom + 26)}px`;
  }
  place();
  addEventListener('resize', place);
  // The main view resizes when the play bar slides away or a panel opens, and
  // neither fires anything this could listen to; two seconds is imperceptible
  // for a bar that only ever moves when the window layout does.
  setInterval(() => { if (document.body.classList.contains('name-that-tune')) place(); }, 2000);

  window.liquifyNttModes = { cfg, buildQueue, startGame, BANDS };
  console.log('[liquify-ntt-modes] ready');
})();
