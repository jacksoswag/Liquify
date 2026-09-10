// liquify-cosmos-shim — restores Spicetify.CosmosAsync on clients that no longer expose it.
//
// Spicetify 2.44.0 against Spotify 1.2.99 leaves both Spicetify.CosmosAsync and
// Spicetify.ReactDOM undefined. Custom apps written against the documented API
// break outright: the Stats app's entire network layer is a single
// `Spicetify.CosmosAsync.get(url)` call, so every request throws before it is
// sent and the page sits on "Loading" forever with nothing in the console but
// the app's own catch. Measured: zero requests to api.spotify.com during a
// thirty-second load.
//
// The shim is the same shape the app expects -- a promise of parsed JSON --
// implemented over fetch with the session's own bearer token, which is exactly
// what the client uses for these calls itself.
//
// The token is attached ONLY to Spotify's own hosts. The Stats app can also be
// pointed at Last.fm, and that request must not carry a Spotify credential.

(function liquifyCosmosShim() {
  const S = window.Spicetify;
  if (!S?.Platform?.AuthorizationAPI) return setTimeout(liquifyCosmosShim, 300);

  // Spicetify's own CosmosAsync, where it exists, sends anything bound for
  // api.spotify.com through a shared public CORS proxy
  // (spicetify:corsProxyTemplate, default https://cors-proxy.spicetify.app).
  // That proxy is rate-limited across everyone using it, which is why the Stats
  // app failed with 429 "API rate limit exceeded" on every endpoint including
  // public ones, why it never cleared, and why it stayed 429 with the client
  // shut for minutes. It was never this account being throttled.
  //
  // So when this machine has credentials for a registered Spotify app, take
  // over: a direct request with that app's token has no proxy in front of it.
  // Without credentials there is nothing better to offer, and Spicetify's
  // version is left alone.
  const haveCreds = () =>
    !!localStorage.getItem('liquify-spotify-refresh-token') &&
    !!localStorage.getItem('liquify-spotify-client-id');
  if (S.CosmosAsync && !haveCreds()) return;
  const inherited = S.CosmosAsync;

  const SPOTIFY_HOST = /^https:\/\/(?:[\w-]+\.)*spotify\.com\//i;

  // ---- the account's own API credentials ----
  //
  // The token the desktop client holds is refused by api.spotify.com outright:
  // every endpoint answers 429 "API rate limit exceeded", including public ones
  // like /browse/new-releases that need no scope at all, and it stays refused
  // with the client shut for minutes. That is not throttling that clears, and
  // it is why custom apps that talk to the Web API cannot work on their own.
  //
  // A token from a registered Spotify app is accepted normally. So if one has
  // been authorised on this machine, its token is used for Spotify's API and
  // the client's is left for everything else.
  //
  // Credentials are read from localStorage, never from this file: this file is
  // committed to a public repository and must never carry them. Authorisation
  // used PKCE, so refreshing needs only the client id and the refresh token --
  // no client secret exists anywhere in the Spotify install.
  const RT_KEY = 'liquify-spotify-refresh-token';
  const CID_KEY = 'liquify-spotify-client-id';
  let cached = { token: '', expires: 0 };

  async function appToken() {
    const rt = localStorage.getItem(RT_KEY);
    const cid = localStorage.getItem(CID_KEY);
    if (!rt || !cid) return '';
    // A minute of headroom, so a request cannot start on a token that expires
    // while it is in flight.
    if (cached.token && Date.now() < cached.expires - 60000) return cached.token;
    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid }),
      });
      if (!res.ok) { console.warn('[liquify-cosmos-shim] token refresh failed', res.status); return ''; }
      const t = await res.json();
      cached = { token: t.access_token, expires: Date.now() + (t.expires_in || 3600) * 1000 };
      // Spotify may hand back a new refresh token; storing it keeps the chain
      // alive rather than letting it expire out from under us.
      if (t.refresh_token) localStorage.setItem(RT_KEY, t.refresh_token);
      return cached.token;
    } catch (e) {
      console.warn('[liquify-cosmos-shim] token refresh error', e);
      return '';
    }
  }

  // _state.token is an object, not a string -- {accessToken, tokenType,
  // accessTokenExpirationTimestampMs, isAnonymous}. Passing it straight into a
  // Bearer header produced "[object Object]" and every call came back 401
  // "Missing/invalid/expired access token", which reads exactly like a scope or
  // login problem and is neither. RequestBuilder._accessToken holds the same
  // string and is used as a fallback.
  const token = () => {
    try {
      const t = S.Platform.AuthorizationAPI._state?.token;
      if (typeof t === 'string') return t;
      if (t?.accessToken) return t.accessToken;
    } catch { /* fall through */ }
    try { return S.Platform.RequestBuilder?._accessToken || ''; } catch { return ''; }
  };

  // The Stats app builds its Last.fm URLs as http://ws.audioscrobbler.com/...
  // This page is https, so a direct request to those is blocked outright as
  // mixed content -- "Failed to fetch (ws.audioscrobbler.com)", before it
  // leaves the browser. Spicetify's proxy hid that by fetching over https
  // itself. Last.fm serves the same API over https, so the scheme is simply
  // upgraded, which also stops the API key travelling in the clear.
  const upgrade = (url) =>
    typeof url === 'string' && url.startsWith('http://') ? 'https://' + url.slice(7) : url;

  async function request(method, rawUrl, body) {
    const url = upgrade(rawUrl);
    const headers = { 'Accept': 'application/json' };
    // Only Spotify's own endpoints see a credential -- the Stats app can also
    // be pointed at Last.fm, and that request must not carry a Spotify token.
    if (SPOTIFY_HOST.test(url)) {
      // The registered app's token first; the client's own only as a fallback,
      // and that one is refused by api.spotify.com anyway.
      const t = (await appToken()) || token();
      if (!t) {
        // Nothing of our own to send. Spicetify's implementation, proxy and
        // all, is still better than failing outright.
        const other = shadowed;
        if (other) return other.resolve ? other.resolve(method, url, body) : other.get(url);
        throw new Error('[liquify-cosmos-shim] no access token available');
      }
      headers.Authorization = 'Bearer ' + t;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // CosmosAsync resolves with parsed JSON and callers test `response.error`
    // or `response.code`, so a failure has to come back in that shape rather
    // than as a rejection -- otherwise the app reports the wrong thing.
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) return Object.assign({ code: res.status, error: res.statusText }, data || {});
    return data;
  }

  const mine = {
    get: (url, body) => request('GET', url, body),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    patch: (url, body) => request('PATCH', url, body),
    head: (url) => request('HEAD', url),
    sub: (url) => request('SUB', url),
    resolve: (method, url, body) => request(String(method || 'GET').toUpperCase(), url, body),
  };

  // Claiming the property is a fight, not a one-off. Spicetify builds its own
  // CosmosAsync after extensions run, and it uses defineProperty -- so a plain
  // assignment is overwritten, and even an accessor installed here is redefined
  // out from under us. Both were tried; both left every request going through
  // the proxy and answering 429 exactly as before.
  //
  // So it is re-asserted until it holds. Cheap, and it only has to win before
  // the first request, which happens when a page that uses the API is opened --
  // long after startup settles.
  let shadowed = inherited;
  const install = () => {
    try {
      const cur = Object.getOwnPropertyDescriptor(S, 'CosmosAsync');
      if (cur && cur.get && cur.get() === mine) return true;
      if (cur && cur.value === mine) return true;
      if (cur && !cur.configurable) return false;
      if (cur) shadowed = cur.get ? cur.get() : cur.value;
      Object.defineProperty(S, 'CosmosAsync', {
        configurable: true,
        get: () => mine,
        set: (v) => { shadowed = v; },
      });
      return true;
    } catch { return false; }
  };
  install();
  let tries = 0;
  const keep = setInterval(() => {
    install();
    if (++tries > 120) clearInterval(keep);   // ~60s of re-asserting, then stop
  }, 500);
  console.log('[liquify-cosmos-shim] CosmosAsync installed (direct, no CORS proxy)');
})();
