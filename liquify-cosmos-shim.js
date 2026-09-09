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

  // Never replace a working implementation: if a later Spicetify starts
  // exposing this again, its version wins.
  if (S.CosmosAsync) return;

  const SPOTIFY_HOST = /^https:\/\/(?:[\w-]+\.)*spotify\.com\//i;

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

  async function request(method, url, body) {
    const headers = { 'Accept': 'application/json' };
    // Only Spotify's own endpoints see the credential.
    if (SPOTIFY_HOST.test(url)) {
      const t = token();
      if (!t) throw new Error('[liquify-cosmos-shim] no access token available');
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

  S.CosmosAsync = {
    get: (url, body) => request('GET', url, body),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    patch: (url, body) => request('PATCH', url, body),
    head: (url) => request('HEAD', url),
    sub: (url) => request('SUB', url),
    resolve: (method, url, body) => request(String(method || 'GET').toUpperCase(), url, body),
  };
  console.log('[liquify-cosmos-shim] Spicetify.CosmosAsync provided (client did not expose one)');
})();
