/* Kingdom Life Study — offline support for the web edition.

   The whole point of the Android app was that it reads with no signal. A
   website has to earn that, and this is what earns it: after the first visit
   every file the app needs is on the phone, and the site opens at the same
   speed on a plane as on wifi.

   Three caches, because three kinds of file want different treatment:

     shell   the app itself — a few small files, replaced wholesale on every
             build, so it is filled at install time and then served without
             ever asking the network again
     books   pack files, which are rewritten in place when a book is
             republished, so the network is asked first and the cache is the
             fallback; a book already read is in IndexedDB anyway
     lexicon the Strong's concordance, three megabytes and effectively frozen,
             so it is fetched once per build and never again

   The build id below is stamped in by build_web.py from a hash of the files
   themselves, so a deploy that changes nothing does not evict anybody's cache. */

const BUILD = "a68c15170859";
const SHELL = 'kls-shell-' + BUILD;
const LEX   = 'kls-lex-'   + BUILD;
const BOOKS = 'kls-books';

const PRECACHE = [
  "./",
  "index.html",
  "styles.css?v=a68c15170859",
  "app.js?v=a68c15170859",
  "web.js?v=a68c15170859",
  "manifest.webmanifest",
  "packs/manifest.json",
  "topics.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg"
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // {cache:'reload'} so a stale copy in the browser's own HTTP cache cannot
    // be what gets frozen into the shell for the life of this build.
    await Promise.all(PRECACHE.map(async url => {
      try {
        const r = await fetch(url, {cache: 'reload'});
        if (r && r.ok) await c.put(url, r);
      } catch (e) { /* a file that cannot be had now is fetched on demand later */ }
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k === SHELL || k === LEX || k === BOOKS) return null;
      if (k.startsWith('kls-')) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

/* The page asks for this when the reader taps Reload on the update card. */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // The catalogue and any book hosted elsewhere are left entirely alone. They
  // are cross-origin, the app already treats both as optional, and caching an
  // opaque response would only hide failures.
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  if (/\/packs\/strongs[^/]*\.json$/.test(path)) { event.respondWith(cacheFirst(req, LEX)); return; }
  if (/\/packs\/.+\.json$/.test(path) && !/manifest\.json$/.test(path)) {
    event.respondWith(networkFirst(req, BOOKS));
    return;
  }
  event.respondWith(shellFirst(req));
});

/* Cached copies are keyed by URL string rather than by the Request, because
   the app fetches several of these with cache:'no-store' and a Request in that
   mode is not something every browser will let you put in a cache. */

async function cacheFirst(req, name){
  const c = await caches.open(name);
  const hit = await c.match(req.url);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && r.ok) c.put(req.url, r.clone());
  return r;
}

async function networkFirst(req, name){
  const c = await caches.open(name);
  try {
    const r = await fetch(req);
    if (r && r.ok) c.put(req.url, r.clone());
    return r;
  } catch (e) {
    const hit = await c.match(req.url);
    if (hit) return hit;
    throw e;
  }
}

/* The shell is rebuilt from scratch on every install, so serving it from the
   cache without checking is not staleness — it is the current build. */
async function shellFirst(req){
  const c = await caches.open(SHELL);
  const hit = await c.match(req.url);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r && r.ok && sameBuildWorthKeeping(req)) c.put(req.url, r.clone());
    return r;
  } catch (e) {
    if (req.mode === 'navigate'){
      const index = await c.match(new URL('index.html', self.location).href)
                 || await c.match(new URL('./', self.location).href);
      if (index) return index;
    }
    return new Response('You are offline and this part of the app has not been saved yet.',
                        {status: 503, statusText: 'Offline'});
  }
}

// Only same-origin app files are worth adding to the shell after the fact.
function sameBuildWorthKeeping(req){
  return !/\/packs\//.test(new URL(req.url).pathname);
}
