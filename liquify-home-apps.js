// liquify-home-apps — renders custom apps as sections on the Home page.
//
// DISABLED. Not listed in config-xpui.ini. Kept because the hard part works and
// is worth not rediscovering; the part that does not is documented below.
//
// WHAT WORKS: getting the real apps out of the bundle.
//
// Spicetify installs a custom app as a lazy route chunk that only Spotify's own
// router references (spicetifyApp1, spicetifyApp2 inside xpui-modules), and the
// router mounts exactly one route at a time. Nothing exposes a handle to them,
// and CSS cannot help: the apps never touch Home's markup, so there is nothing
// hidden there to reveal.
//
// What does work is going through the bundler. The chunks register themselves
// on rspackChunkclient_web -- note the name, this build is rspack, not webpack,
// and window.webpackChunkclient_web is undefined -- and pushing an entry with a
// callback hands back the require function. Its factory map req.m holds the
// module, and running that factory against an exports object of our own yields
// the app's real default export: the same render() the router would have used.
// req(id) is NOT enough; it returns an empty exports object.
//
// So these are the actual apps, not copies -- verified: Stats resolves to a
// React element of type App, Name That Tune to type Gn.
//
// WHAT DOES NOT WORK: putting them there. Appending these sections to
// .main-home-content -- a container React owns -- breaks its reconciliation.
// Home did not merely look wrong, it threw and rendered Spotify's own
// "Something went wrong. Try reloading the page." in place of the entire main
// view, with the two sections left detached and never attached at all.
//
// Any fix has to insert into something React does not reconcile, or mount
// through a portal from inside Spotify's own tree rather than by appending DOM
// from outside it. Until then this stays off.

(function liquifyHomeApps() {
  const S = window.Spicetify;
  if (!S?.React || !S?.ReactDOM?.createRoot || !S?.Platform?.History) {
    return setTimeout(liquifyHomeApps, 400);
  }

  const APPS = [
    { id: 'spicetify-routes-stats', title: 'Statistics', route: '/stats' },
    { id: 'spicetify-routes-name-that-tune', title: 'Name That Tune', route: '/name-that-tune' },
  ];

  function getRequire() {
    const g = window.rspackChunkclient_web || window.webpackChunkclient_web;
    if (!g) return null;
    let req = null;
    try { g.push([['lqx-home-' + Date.now()], {}, (r) => { req = r; }]); } catch { return null; }
    return req;
  }

  function loadApp(req, id) {
    // The chunk has to be fetched before its factory exists. Already-loaded
    // chunks resolve immediately.
    return req.e(id).then(() => {
      const exports = {};
      const mod = { exports, id, loaded: false };
      req.m[id](mod, exports, req);
      const ex = mod.exports || exports;
      if (typeof ex.default !== 'function') throw new Error('no default export');
      return ex.default;
    });
  }

  // Hosts are built once and kept. Re-attaching the same node when Home comes
  // back preserves each app's React state -- which matters more than it sounds:
  // the Stats app fetches its whole dataset on mount, and remounting on every
  // visit to Home is what rate-limits the account.
  const hosts = new Map();

  function buildHost(app) {
    const section = document.createElement('section');
    section.className = 'lqx-home-app';
    section.dataset.lqxHomeApp = app.id;

    const head = document.createElement('div');
    head.className = 'lqx-home-app__head';
    const h = document.createElement('h2');
    h.textContent = app.title;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'lqx-home-app__open';
    open.textContent = 'Open';
    open.addEventListener('click', () => S.Platform.History.push(app.route));
    head.append(h, open);

    const body = document.createElement('div');
    body.className = 'lqx-home-app__body';

    section.append(head, body);
    return { section, body };
  }

  let mounting = false;
  async function mountAll() {
    if (mounting || hosts.size) return;
    mounting = true;
    const req = getRequire();
    if (!req) { mounting = false; return; }
    for (const app of APPS) {
      try {
        const render = await loadApp(req, app.id);
        const { section, body } = buildHost(app);
        const root = S.ReactDOM.createRoot(body);
        root.render(render());
        hosts.set(app.id, section);
      } catch (e) {
        console.warn('[liquify-home-apps] could not mount', app.id, e);
      }
    }
    mounting = false;
    place();
  }

  // Appended after the shortcuts grid, in the order APPS declares.
  function place() {
    const content = document.querySelector('[data-testid="home-page"] .main-home-content');
    if (!content) return;
    for (const app of APPS) {
      const section = hosts.get(app.id);
      if (section && section.parentElement !== content) content.appendChild(section);
    }
  }

  const onHome = () => S.Platform.History.location?.pathname === '/';

  function tick() {
    if (!onHome()) return;
    if (!hosts.size) mountAll(); else place();
  }
  S.Platform.History.listen(() => setTimeout(tick, 300));
  setInterval(tick, 1500);
  setTimeout(tick, 1200);

  const style = document.createElement('style');
  style.id = 'lqx-home-apps-style';
  style.textContent = `
    .lqx-home-app{display:flex;flex-direction:column;gap:8px;margin-top:32px}
    .lqx-home-app__head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .lqx-home-app__head h2{margin:0;font-size:1.35rem;font-weight:700;letter-spacing:-.01em}
    .lqx-home-app__open{appearance:none;border:0;cursor:pointer;border-radius:999px;
      padding:5px 14px;font:600 12px/1 inherit;color:rgba(255,255,255,.72);
      background:rgba(255,255,255,.08);transition:background .16s ease,color .16s ease}
    .lqx-home-app__open:hover{background:rgba(255,255,255,.16);color:#fff}
    /* The apps are written for a full-height route. Boxed in here so one cannot
       push the next one off the bottom of the page. */
    .lqx-home-app__body{position:relative;max-height:640px;overflow:auto;border-radius:16px}
    /* Their own page chrome assumes it owns the viewport. */
    .lqx-home-app__body .main-topBar-topbarContent,
    .lqx-home-app__body .main-actionBar-ActionBarContainer{display:none!important}`;
  document.head.appendChild(style);

  window.liquifyHomeApps = { hosts, mountAll, place };
  console.log('[liquify-home-apps] ready');
})();
