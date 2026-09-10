// liquify-ntt-modes — where Name That Tune gets its songs from, and how hard.
//
// The game itself has no notion of a source: it plays whatever is already in
// the queue, and its only other input is a URI list handed to it through
//
//     History.push({ pathname: '/name-that-tune', search: '?t=' + Date.now(),
//                    state: { URIs: [...] } })
//
// which is how its context-menu entry works. That contract is the whole
// integration here. The app is not forked: this builds a track list and hands
// it over the same way, so the game keeps running its own round logic.
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

  const SRC_KEY = 'liquify-ntt-source';
  const DIFF_KEY = 'liquify-ntt-difficulty';
  const ARG_KEY = 'liquify-ntt-arg';
  const ARG_URI_KEY = 'liquify-ntt-arg-uri';
  const QUEUE_KEY = 'liquify-ntt-queue';        // the URIs of the game in progress

  // Playcount floors. Calibrated against real tracks rather than round numbers:
  // a 100M-stream song is one nearly everyone has heard, 10M is a song that
  // charted or went round somewhere, 500k is a real release with an audience
  // rather than an upload. Below that is where unnameable filler lives, which
  // is what "impossible" is for.
  const BANDS = { easy: 100e6, medium: 10e6, hard: 500e3, impossible: 0 };

  const SOURCES = [
    ['library', 'Your Library'],
    ['artist', 'Artist'],
    ['genre', 'Genre'],
    ['all', 'All Spotify'],
  ];
  const DIFFICULTIES = [
    ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['impossible', 'Impossible'],
  ];
  const LABELS = Object.fromEntries(SOURCES);

  const TARGET = 60;              // tracks handed to the game; it shuffles them
  // Ceiling on album queries per game, whatever the mode. Measured: ~120ms
  // each, and a run stops as soon as it has enough, so this is the worst case
  // rather than the usual one.
  const MAX_ALBUM_QUERIES = 24;

  const cfg = () => ({
    source: localStorage.getItem(SRC_KEY) || 'library',
    difficulty: localStorage.getItem(DIFF_KEY) || 'medium',
    arg: localStorage.getItem(ARG_KEY) || '',
    // Set only by picking from the suggestion list, and dropped the moment the
    // text is edited -- otherwise typing over a chosen artist would quietly
    // keep quizzing you on the old one.
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

  // Every GraphQL call this file makes goes through here, and it is also what
  // marks a call as ours for the interceptor further down -- which rewrites the
  // GAME's searches and must not touch this file's own.
  let ourCall = false;
  function gql(def, vars) {
    const d = typeof def === 'string' ? Spicetify.GraphQL.Definitions[def] : def;
    ourCall = true;
    try { return Spicetify.GraphQL.Request(d, vars); } finally { ourCall = false; }
  }

  // The search the search modal uses. Every one of these variables is required;
  // omit any and the call comes back HttpResponseError with nothing to say
  // about which. Results arrive as one ranked list of mixed entity types under
  // topResultsV2, not as per-type sections, so callers filter by __typename.
  async function searchTop(term, limit = 10) {
    const r = await gql('searchModalResults', {
      searchTerm: term, offset: 0, limit, numberOfTopResults: limit,
      includeAudiobooks: true, includeArtistHasConcertsField: false,
      includePreReleases: false, includeLocalConcertsField: false, includeAuthors: false,
    });
    return (r?.data?.searchV2?.topResultsV2?.itemsV2 || []).map((i) => i.item?.data).filter(Boolean);
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
      const r = await gql(PERSISTED.searchArtists, {
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

  // Genres come off the same top-results query Spotify's own search page runs,
  // which surfaces far more of them than the modal search does (17 for "jaz"
  // against six). It still misses plenty -- neither query returns a Genre for
  // "shoe", or for the whole word "hyperpop" -- which is what the fixed list
  // further down is for.
  async function searchGenres(term) {
    try {
      const r = await gql(PERSISTED.searchTopResultsList, {
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
        .filter((d) => d.__typename === 'Genre' && d.name).map((d) => d.name);
    }
  }

  // Albums and singles both count: a single is often where the one track people
  // know actually lives, and excluding them would quietly remove most of what
  // "easy" means for recent artists.
  //
  // Releases carry their own playability, and unplayable ones are dropped here
  // rather than one track at a time: a pre-release, or a record withdrawn in
  // this market, yields nothing but tracks the player refuses -- which is what
  // produces Spotify's "can't play this right now, import it from your
  // computer" notice in the middle of a game.
  async function artistAlbums(artistUri, n = 8) {
    const r = await gql('queryArtistDiscographyAll', { uri: artistUri, offset: 0, limit: 40 });
    const items = r?.data?.artistUnion?.discography?.all?.items || [];
    const uris = items
      .map((i) => i.releases?.items?.[0])
      .filter((rel) => rel?.uri && rel.playability?.playable !== false)
      .map((rel) => rel.uri);
    return shuffle(uniq(uris)).slice(0, n);
  }

  // The one call that carries playcount, and the reason the whole design is
  // album-shaped: a single request decorates every track on the record.
  //
  // `playable === true`, not merely "not false": an absent field is not a
  // promise, and a track the player then refuses ends a round with an error
  // notice instead of a song.
  async function albumTracks(albumUri) {
    const r = await gql('queryAlbumTracks', { uri: albumUri, offset: 0, limit: 60 });
    const items = r?.data?.albumUnion?.tracksV2?.items || r?.data?.albumUnion?.tracks?.items || [];
    return items
      .map((i) => i.track)
      .filter((t) => t?.uri?.startsWith('spotify:track:') && t.playability?.playable === true)
      .map((t) => ({
        uri: t.uri,
        name: t.name || '',
        artist: (t.artists?.items || []).map((a) => a.profile?.name).filter(Boolean)[0] || '',
        plays: Number(t.playcount) || 0,
      }));
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

  // ---- one song per song -----------------------------------------------------
  //
  // A discography is full of the same song several times over: the album cut,
  // the instrumental, the remaster, the live take, the radio edit, the deluxe
  // reissue. Twelve steps through a Tyler, The Creator queue turned up OKAGA CA
  // twice and THE BROWN STAINS OF DARKEESE LATIF twice, which is a worse game
  // than a shorter one.
  //
  // The normalisation deliberately MIRRORS the game's own answer check, which
  // strips bracketed suffixes, everything after " - ", ampersands, diacritics
  // and punctuation before comparing a guess. Anything the game would accept as
  // the same answer is therefore the same song here by definition -- which
  // rules out the failure where two entries are distinct to the quiz but
  // identical to the person playing it.
  const songKey = (t) => {
    let s = (t.name || '').trim().toLowerCase();
    s = s.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '');
    s = s.replace(/\s-\s.*$/, '');
    s = s.replace(/&/g, 'and');
    s = s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    s = s.replace(/[^\p{L}\p{N}]/gu, '');
    // Keyed by artist too, so two different songs that happen to share a title
    // are not collapsed into one.
    return `${s} ${(t.artist || '').trim().toLowerCase()}`;
  };

  // Keeps the most-played version of each song. That is the one you are most
  // likely to know, so it is also the one the difficulty band was chosen for --
  // whereas keeping whichever happened to be seen first hands you the
  // instrumental of a song you would have named instantly.
  function dedupe(tracks) {
    const best = new Map();
    for (const t of tracks) {
      const k = songKey(t);
      if (k.startsWith(' ')) continue;          // no title at all
      const cur = best.get(k);
      if (!cur || t.plays > cur.plays) best.set(k, t);
    }
    return [...best.values()];
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
    const albums = shuffle([...perAlbum.entries()]).sort((x, y) => y[1] - x[1]).map(([uri]) => uri);

    const decorated = await tracksFromAlbums(albums, floor, TARGET * 2);
    const mine = decorated.filter((t) => savedUris.has(t.uri));

    // Below "hard" the floor stops doing anything useful for a personal library
    // -- most of what people save has few enough streams that the band would
    // empty -- so a thin result falls back to the library unfiltered rather
    // than refusing to start.
    if (mine.length >= 8) return mine;
    return saved.map((t) => ({
      uri: t.uri, name: t.name || '',
      artist: (t.artists || []).map((a) => a.name).filter(Boolean)[0] || '', plays: 0,
    }));
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
  // a person would: find artists for it, then take their records. Three albums
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
  const randomSeed = () => SEEDS[Math.floor(Math.random() * 26)] + SEEDS[Math.floor(Math.random() * 26)];

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
    let tracks;
    if (source === 'artist') tracks = await fromArtist(arg, floor, argUri);
    else if (source === 'genre') tracks = await fromGenre(arg, floor);
    else if (source === 'all') tracks = await fromAll(floor);
    else tracks = await fromLibrary(floor);
    return dedupe(tracks);
  }

  // ---- scoping the game's own suggestions ------------------------------------
  //
  // The guess box runs its own search, through Spicetify.GraphQL.Request with
  // whichever of searchSuggestions / searchModalResults the client exposes. In
  // artist mode a box offering the whole catalogue is not a hint, it is a
  // different game -- so the search term is scoped to the chosen artist on the
  // way past.
  //
  // Done by rewriting the term rather than by filtering results, because the
  // filter Spotify applies server-side is the good one: "earf" scoped to Tyler,
  // The Creator returns EARFQUAKE and its remix and nothing else, where
  // filtering the unscoped results would leave whichever of that artist's
  // tracks happened to rank for the letters typed.
  //
  // Narrow on purpose. It fires only on the game's route, only in artist mode,
  // only with an artist actually chosen, only for those two search operations,
  // and never for this file's own calls -- which is what `ourCall` is for.
  (function scopeGuessSuggestions() {
    const SEARCH_OPS = new Set(['searchSuggestions', 'searchModalResults']);

    const scope = (def, vars) => {
      try {
        if (ourCall || !vars || !SEARCH_OPS.has(def?.name)) return vars;
        if (!document.body.classList.contains('name-that-tune')) return vars;
        const c = cfg();
        if (c.source !== 'artist' || !c.argUri || !c.arg) return vars;
        // The two operations name the term differently.
        const field = 'query' in vars ? 'query' : 'searchTerm' in vars ? 'searchTerm' : null;
        if (!field || typeof vars[field] !== 'string' || vars[field].includes('artist:')) return vars;
        return { ...vars, [field]: `artist:"${c.arg}" ${vars[field]}` };
      } catch { return vars; }   // never let scoping break a search
    };

    // Installed as an accessor, and re-installed if the object is swapped.
    //
    // A plain assignment here does nothing, which is how the first version of
    // this shipped broken: Spicetify hands out a GraphQL object during early
    // boot and REPLACES it once its real client is ready, so a wrapper written
    // over Request at extension-load time is thrown away before anything ever
    // calls it. (Spicetify.GraphQL.Request.name was "" rather than the
    // wrapper's, which is how that was caught.)
    //
    // The setter is the part that matters: whatever Spicetify assigns later
    // becomes the thing the wrapper delegates to, instead of replacing it.
    // The game dedupes its own suggestions by URI, and a song has as many URIs
    // as it has recordings -- so typing "awk" offered Awkward, Awkward and
    // Awkward - Instrumental, three separate entries for one answer. Collapsed
    // here with the same key the queue uses, which is also the key the game's
    // answer check uses: if picking either would be scored identically, showing
    // both is just a longer list.
    //
    // The first survivor wins rather than the most-played one, because a search
    // response carries no playcount -- and Spotify's own ranking already puts
    // the canonical recording above its variants.
    const dedupeTracks = (r) => {
      try {
        const items = r?.data?.searchV2?.topResultsV2?.itemsV2;
        if (!Array.isArray(items)) return r;
        const seen = new Set();
        const kept = items.filter((i) => {
          const d = i?.item?.data;
          if (i?.item?.__typename !== 'TrackResponseWrapper' || !d?.name) return true;
          const k = songKey({
            name: d.name,
            artist: (d.artists?.items || []).map((a) => a.profile?.name).filter(Boolean)[0] || '',
          });
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (kept.length === items.length) return r;
        // Rebuilt rather than spliced: this is Spotify's own response object,
        // and the search modal may still be holding it.
        return { ...r, data: { ...r.data, searchV2: { ...r.data.searchV2,
          topResultsV2: { ...r.data.searchV2.topResultsV2, itemsV2: kept } } } };
      } catch { return r; }
    };

    const isGameSearch = (def) =>
      !ourCall && SEARCH_OPS.has(def?.name) && document.body.classList.contains('name-that-tune');

    const patch = (obj) => {
      if (!obj || typeof obj.Request !== 'function' || obj.__lqxScoped) return;
      let real = obj.Request.bind(obj);
      const wrapper = (def, vars, ...rest) => {
        const mine = isGameSearch(def);
        const out = real(def, scope(def, vars), ...rest);
        return mine ? Promise.resolve(out).then(dedupeTracks) : out;
      };
      try {
        Object.defineProperty(obj, 'Request', {
          configurable: true,
          get: () => wrapper,
          set: (v) => { real = typeof v === 'function' ? v.bind(obj) : v; },
        });
        Object.defineProperty(obj, '__lqxScoped', { value: true, configurable: true });
      } catch { /* frozen object -- scoping is a nicety, not a requirement */ }
    };

    patch(Spicetify.GraphQL);
    let current = Spicetify.GraphQL;
    try {
      Object.defineProperty(Spicetify, 'GraphQL', {
        configurable: true,
        get: () => current,
        set: (v) => { current = v; patch(v); },
      });
    } catch {}
  })();

  // ---- is a game running -----------------------------------------------------
  //
  // "Active" means the track playing is one this panel queued. That is what
  // survives both walking away from the page and restarting Spotify, and it
  // goes false on its own once you play something else -- so the panel opens
  // when there is nothing to come back to, and stays out of the way when there
  // is.
  const loadQueue = () => {
    try { return new Set(JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')); } catch { return new Set(); }
  };
  let gameQueue = loadQueue();
  const gameActive = () => gameQueue.has(Spicetify.Player.data?.item?.uri || ' ');

  // ---- the panel -------------------------------------------------------------
  //
  // Fixed, and never a child of anything the game renders. The whole main view
  // belongs to React, and appending into a React-owned parent is what broke the
  // home page the last time something was injected there -- reconciliation and
  // a stray DOM node do not coexist. So this floats over the page and is
  // positioned from the main view's own rectangle.

  const style = document.createElement('style');
  style.id = 'lqx-ntt-modes-style';
  style.textContent = `
    /* Above the game's own suggestion dropdown, which sits at z-index 100:
       otherwise the panel opens UNDER a list of song titles left over from the
       guess box behind it. */
    #lqx-ntt-root{position:fixed;z-index:200;display:none;pointer-events:none}
    body.name-that-tune #lqx-ntt-root{display:block}

    /* A bare plus in the corner. No label and no chrome: the page it sits on
       is one guess box and three controls, and the only thing this needs to be
       is findable without competing with them. Sized and coloured like the
       game's own tertiary controls so it reads as part of the page. */
    #lqx-ntt-new{position:absolute;top:0;right:0;pointer-events:auto;display:none;
      align-items:center;justify-content:center;width:30px;height:30px;
      appearance:none;border:0;cursor:pointer;background:transparent;border-radius:50%;
      padding:0;color:var(--spice-subtext)}
    #lqx-ntt-new:hover{color:var(--spice-text);background:rgba(255,255,255,.08)}
    #lqx-ntt-root[data-panel="0"] #lqx-ntt-new{display:inline-flex}

    /* A scrim, so the page behind reads as inactive and a stray click lands
       somewhere harmless rather than on the guess box. Sized from the viewport
       rather than from the root, which is inset to the main view. */
    #lqx-ntt-scrim{position:fixed;inset:0;display:none;pointer-events:auto;
      background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
    #lqx-ntt-root[data-panel="1"] #lqx-ntt-scrim{display:block}

    #lqx-ntt-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
      pointer-events:auto;display:none;flex-direction:column;gap:16px;
      width:min(400px,86%);padding:22px;border-radius:20px;
      background:color-mix(in srgb,var(--spice-main) 76%,transparent);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 26px 60px rgba(0,0,0,.5);
      backdrop-filter:blur(30px)}
    #lqx-ntt-root[data-panel="1"] #lqx-ntt-panel{display:flex}

    #lqx-ntt-panel h2{margin:0;font:inherit;font-size:17px;font-weight:700;color:var(--spice-text)}
    #lqx-ntt-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #lqx-ntt-close{appearance:none;border:0;cursor:pointer;border-radius:50%;width:26px;height:26px;
      font:inherit;font-size:14px;line-height:1;color:var(--spice-subtext);
      background:rgba(255,255,255,.09);display:none}
    #lqx-ntt-close:hover{color:var(--spice-text);background:rgba(255,255,255,.16)}
    #lqx-ntt-root[data-active="1"] #lqx-ntt-close{display:block}

    .lqx-ntt-field{display:flex;flex-direction:column;gap:7px}
    .lqx-ntt-label{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
      color:var(--spice-subtext)}
    .lqx-ntt-seg{display:flex;flex-wrap:wrap;gap:6px}
    .lqx-ntt-seg button{appearance:none;border:0;cursor:pointer;border-radius:999px;
      padding:7px 13px;font:inherit;font-size:12px;font-weight:600;
      color:var(--spice-subtext);background:rgba(255,255,255,.08)}
    .lqx-ntt-seg button:hover{color:var(--spice-text);background:rgba(255,255,255,.15)}
    .lqx-ntt-seg button[aria-pressed="true"]{color:var(--spice-main);background:var(--spice-text)}

    #lqx-ntt-argfield{display:none}
    #lqx-ntt-root[data-arg="1"] #lqx-ntt-argfield{display:flex}
    #lqx-ntt-argwrap{position:relative;display:flex}
    #lqx-ntt-arg{width:100%;appearance:none;border:0;border-radius:10px;padding:9px 12px;
      font:inherit;font-size:13px;color:var(--spice-text);background:rgba(255,255,255,.09)}
    #lqx-ntt-arg:focus{outline:none;background:rgba(255,255,255,.15)}
    #lqx-ntt-arg::placeholder{color:var(--spice-subtext)}

    #lqx-ntt-sugg{position:absolute;top:calc(100% + 6px);left:0;z-index:1;
      display:none;flex-direction:column;width:100%;max-height:196px;overflow-y:auto;
      overscroll-behavior:contain;padding:4px;border-radius:11px;
      background:color-mix(in srgb,var(--spice-main) 96%,transparent);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 14px 34px rgba(0,0,0,.45)}
    #lqx-ntt-sugg[data-open="1"]{display:flex}
    #lqx-ntt-sugg button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;
      appearance:none;border:0;cursor:pointer;border-radius:7px;padding:6px 8px;font:inherit;
      font-size:12px;color:var(--spice-text);background:transparent}
    #lqx-ntt-sugg button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #lqx-ntt-sugg img{flex:0 0 auto;width:26px;height:26px;border-radius:50%;object-fit:cover}
    #lqx-ntt-sugg button:hover,#lqx-ntt-sugg button[data-on="1"]{background:rgba(255,255,255,.14)}

    /* One message, mine, and nothing else while the game is open.
       Starting a game produced a stack of three: Spotify's "can't play this
       right now", the game's own "Shuffled 60 Songs", and this file's summary.
       Rather than filter the other two by their text -- which is translated,
       and one of them is Spotify's own -- every snackbar is suppressed on this
       route and the one message worth showing is rendered here instead. It is
       therefore NOT a snackbar, which is exactly why it survives the rule. */
    #lqx-ntt-toast{position:fixed;left:50%;bottom:34px;transform:translate(-50%,10px);
      pointer-events:none;opacity:0;transition:opacity .18s ease,transform .18s ease;
      max-width:min(520px,80vw);padding:12px 20px;border-radius:8px;
      font:inherit;font-size:13px;font-weight:600;text-align:center;
      color:var(--spice-main);background:var(--spice-text);
      box-shadow:0 8px 26px rgba(0,0,0,.4)}
    #lqx-ntt-toast[data-show="1"]{opacity:1;transform:translate(-50%,0)}
    #lqx-ntt-toast[data-error="1"]{color:#fff;background:#c0392b}

    body.name-that-tune .notistack-Snackbar{display:none!important}

    #lqx-ntt-go{appearance:none;border:0;cursor:pointer;border-radius:999px;padding:11px 18px;
      font:inherit;font-size:13px;font-weight:700;color:var(--spice-main);background:var(--spice-button)}
    #lqx-ntt-go:disabled{opacity:.55;cursor:progress}

    /* The play bar goes for the whole of the game, not just while a round is
       being guessed. The game hides its left-hand side itself -- cover, title,
       artist -- but leaves the transport, the scrubber and the track time
       sitting under the guess box, where they are no use (the game has its own
       Play 1s). Route-wide rather than round-wide so it does not slide back in
       and out between every reveal and the next song.

       The slide, the timing and the extra 24px that carries the floating
       player's shadow out with it are liquify-keys' -- the transition it
       installs lives on the bar unconditionally, so this animates on the way in
       as well. The html-body prefix is needed for the same reason it is needed
       there: the Dynamic Search Bar snippet sets transform:none !important on
       both of these selectors, and this has to outrank it. */
    html body.name-that-tune .Root__now-playing-bar,
    html body.name-that-tune aside[aria-label="Now playing bar"]{
      transform:translateY(calc(100% + 24px))!important;opacity:0!important;
      visibility:hidden!important;pointer-events:none!important;
      transition:transform .34s cubic-bezier(.32,.72,0,1),opacity .26s ease,visibility 0s linear .34s}`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'lqx-ntt-root';
  root.innerHTML = `
    <div id="lqx-ntt-scrim"></div>
    <div id="lqx-ntt-toast" role="status"></div>
    <button id="lqx-ntt-new" type="button" aria-label="New game" title="New game"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="11" y="4" width="2" height="16" rx="1"></rect><rect x="4" y="11" width="16" height="2" rx="1"></rect></svg></button>
    <div id="lqx-ntt-panel" role="dialog" aria-label="New game">
      <div id="lqx-ntt-head">
        <h2>New game</h2>
        <button id="lqx-ntt-close" type="button" aria-label="Close">&#10005;</button>
      </div>
      <div class="lqx-ntt-field">
        <span class="lqx-ntt-label">Songs from</span>
        <div class="lqx-ntt-seg" id="lqx-ntt-source"></div>
      </div>
      <div class="lqx-ntt-field" id="lqx-ntt-argfield">
        <span class="lqx-ntt-label" id="lqx-ntt-arglabel">Artist</span>
        <span id="lqx-ntt-argwrap">
          <input id="lqx-ntt-arg" type="text" spellcheck="false" autocomplete="off">
          <span id="lqx-ntt-sugg" role="listbox"></span>
        </span>
      </div>
      <div class="lqx-ntt-field">
        <span class="lqx-ntt-label">Difficulty</span>
        <div class="lqx-ntt-seg" id="lqx-ntt-diff"></div>
      </div>
      <button id="lqx-ntt-go" type="button">Start</button>
    </div>`;
  document.body.appendChild(root);

  const $new = root.querySelector('#lqx-ntt-new');
  const $close = root.querySelector('#lqx-ntt-close');
  const $srcSeg = root.querySelector('#lqx-ntt-source');
  const $diffSeg = root.querySelector('#lqx-ntt-diff');
  const $argLabel = root.querySelector('#lqx-ntt-arglabel');
  const $arg = root.querySelector('#lqx-ntt-arg');
  const $sugg = root.querySelector('#lqx-ntt-sugg');
  const $go = root.querySelector('#lqx-ntt-go');
  const $toast = root.querySelector('#lqx-ntt-toast');

  // Deliberately not Spicetify.showNotification: that renders a snackbar, and
  // snackbars are hidden on this route. Same dismissal feel, one at a time.
  let toastTimer = null;
  function toast(message, isError) {
    $toast.textContent = message;
    $toast.dataset.error = isError ? '1' : '0';
    $toast.dataset.show = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.dataset.show = '0'; }, isError ? 4200 : 3200);
  }

  const paintSegment = (el, value) => {
    for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  };

  function buildSegment(el, options, key, onPick) {
    el.textContent = '';
    for (const [value, label] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.value = value;
      b.addEventListener('click', () => {
        localStorage.setItem(key, value);
        paintSegment(el, value);
        onPick(value);
      });
      el.appendChild(b);
    }
  }

  const setBusy = (b) => {
    $go.disabled = b;
    $go.textContent = b ? 'Finding songs...' : 'Start';
  };

  const openPanel = (open) => {
    root.dataset.panel = open ? '1' : '0';
    if (open) setTimeout(() => { if (root.dataset.arg === '1') $arg.focus(); }, 20);
    else closeSuggestions();
  };

  function syncArgField() {
    const src = cfg().source;
    const needsArg = src === 'artist' || src === 'genre';
    root.dataset.arg = needsArg ? '1' : '0';
    $argLabel.textContent = src === 'genre' ? 'Genre' : 'Artist';
    $arg.placeholder = src === 'genre' ? 'e.g. shoegaze' : 'e.g. Daft Punk';
  }

  // ---- suggestions -----------------------------------------------------------
  //
  // Genres cannot rely on Spotify alone: it returns Genre entities only for
  // terms it already considers a genre, and mostly only once the word is nearly
  // complete -- "jaz" offers Jazz, Cool jazz and Smooth Jazz, while "shoe" and
  // even the whole of "hyperpop" offer none. Live hits merge with this list,
  // which is what makes the partial-word case work at all.
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
    // name again at start, removes the chance of resolving it differently, and
    // is what lets the guess box be scoped to that artist.
    if (item.uri) localStorage.setItem(ARG_URI_KEY, item.uri);
    else localStorage.removeItem(ARG_URI_KEY);
    closeSuggestions();
  }

  async function fetchSuggestions(term) {
    const token = ++suggestToken;
    const q = term.trim();
    // One character is enough -- Spotify's own search answers "x" with
    // XXXTENTACION, X, Juice WRLD and Charli xcx, and there is no reason for
    // this box to be pickier than the one it borrows results from.
    if (!q) return closeSuggestions();

    let list = [];
    if (cfg().source === 'genre') {
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

  // ---- starting a game -------------------------------------------------------

  async function startGame() {
    const c = cfg();
    if ((c.source === 'artist' || c.source === 'genre') && !c.arg.trim()) {
      toast(`Enter ${c.source === 'artist' ? 'an artist' : 'a genre'} first`, true);
      $arg.focus();
      return;
    }
    setBusy(true);
    try {
      const tracks = await buildQueue(c);
      if (!tracks.length) {
        // Harder means a LOWER playcount floor, so an empty easy round is fixed
        // by going harder, not easier. Worth stating: the instinct on an empty
        // result is to reach the other way.
        toast(`Nothing that popular in ${LABELS[c.source]} - try a harder difficulty`, true);
        return;
      }
      const uris = shuffle(uniq(tracks.map((t) => t.uri))).slice(0, TARGET);
      gameQueue = new Set(uris);
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(uris)); } catch {}
      openPanel(false);
      // The app's own contract, unchanged: it expands, shuffles and plays what
      // arrives in state.URIs, and the timestamp is what makes an identical
      // route a new game rather than a no-op.
      Spicetify.Platform.History.push({
        pathname: '/name-that-tune',
        search: `?t=${Date.now()}`,
        state: { URIs: uris },
      });
      toast(`${uris.length} songs - ${LABELS[c.source]}, ${c.difficulty}`);
    } catch (e) {
      toast(String(e?.message || e), true);
    } finally {
      setBusy(false);
    }
  }

  // ---- wiring ----------------------------------------------------------------

  const c0 = cfg();
  buildSegment($srcSeg, SOURCES, SRC_KEY, () => {
    // An artist URI means nothing once the source is a genre, and vice versa.
    localStorage.removeItem(ARG_URI_KEY);
    closeSuggestions();
    syncArgField();
    if (root.dataset.arg === '1') $arg.focus();
  });
  buildSegment($diffSeg, DIFFICULTIES, DIFF_KEY, () => {});
  paintSegment($srcSeg, c0.source);
  paintSegment($diffSeg, c0.difficulty);
  $arg.value = c0.arg;
  syncArgField();

  $go.addEventListener('click', startGame);
  $new.addEventListener('click', () => openPanel(true));
  $close.addEventListener('click', () => openPanel(false));
  // Clicking away closes the panel only when there is a game behind it. With no
  // game there is nothing to dismiss TO, and a panel that vanished would leave
  // the page with no way back to it except the button it just hid.
  root.querySelector('#lqx-ntt-scrim').addEventListener('mousedown', () => {
    if (gameActive()) openPanel(false);
  });

  // Typing here must not reach the keybinds, which are global and would read a
  // bare letter as a shortcut. Escape closes the panel, but only when there is
  // a game behind it to go back to.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.dataset.panel === '1' && gameActive()) openPanel(false);
    e.stopPropagation();
  });

  // The panel opens by itself when you arrive with no game to come back to, and
  // stays shut otherwise. Only on ARRIVAL: reopening it under someone who has
  // just closed it would be worse than never opening it at all.
  let wasOnRoute = false;
  function syncRoute() {
    const onRoute = /^\/name-that-tune/.test(Spicetify.Platform?.History?.location?.pathname || '');
    const active = onRoute && gameActive();
    root.dataset.active = active ? '1' : '0';
    if (onRoute && !wasOnRoute) openPanel(!active);
    if (!onRoute) closeSuggestions();
    wasOnRoute = onRoute;
  }

  // Anchored to the main view rather than centred on the window: the sidebar
  // and the friend feed are not the same width, so window-centred would sit
  // visibly off from the game's own column.
  function place() {
    const view = document.querySelector('.Root__main-view');
    if (!view) return;
    const r = view.getBoundingClientRect();
    root.style.left = `${Math.round(r.left + 24)}px`;
    root.style.top = `${Math.round(r.top + 20)}px`;
    root.style.width = `${Math.round(r.width - 48)}px`;
    root.style.height = `${Math.round(r.height - 40)}px`;
  }

  place();
  syncRoute();
  addEventListener('resize', place);
  try { Spicetify.Platform.History.listen(() => { place(); syncRoute(); }); } catch {}
  // Whether a game is running can only change when the song does.
  Spicetify.Player.addEventListener('songchange', syncRoute);
  // The main view resizes when the play bar slides away or a panel opens, and
  // neither fires anything this could listen to.
  setInterval(() => { if (document.body.classList.contains('name-that-tune')) place(); }, 2000);

  window.liquifyNttModes = { cfg, buildQueue, startGame, dedupe, songKey, BANDS, gameActive };
  console.log('[liquify-ntt-modes] ready');
})();
