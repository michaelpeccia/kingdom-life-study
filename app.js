/* Kingdom Life Study — reader, marks, packs and concordance.
   Vanilla JS on purpose: no build step, no dependencies, works inside a
   Capacitor WebView and in any browser. */
(() => {
'use strict';

/* ── tiny helpers ─────────────────────────────────────────────────────── */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n=document.createElement(tag);
  if(cls) n.className=cls; if(txt!=null) n.textContent=txt; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const debounce = (fn, ms) => { let t; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a),ms);}; };

/* Open a link without leaving the app.

   Inside Capacitor this hands the URL to Chrome Custom Tabs on Android and
   SFSafariViewController on iOS - a real browser sheet that slides over the app
   with a Done button, so the reader comes straight back to where they were.

   An <iframe> would keep the page literally inside our own layout, but it does
   not work here: BibleGateway and most publishers send X-Frame-Options or a
   frame-ancestors policy that forbids being embedded, so the frame would come
   back blank. The browser sheet is also what both stores expect. */
async function openLink(url){
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.Browser){
    try {
      await P.Browser.open({
        url,
        toolbarColor: State.prefs.theme==='dark' ? '#15161C' : '#1B1B2F',
        presentationStyle: 'popover',
      });
      return;
    } catch(e){ /* fall through to a normal tab */ }
  }
  openOut(url);
}

/* Open a URL from a browser, by clicking a real link.

   window.open() is what this used to do, and on a phone it silently does
   nothing. Once the app has been added to the home screen it runs standalone,
   with no browser chrome and no tab to open into, and both iOS and Android
   refuse the call outright — no error, no window, and a button that looks
   broken. A genuine anchor is navigation rather than script, so the browser
   handles it itself and it works in a tab, in the installed app, and inside a
   WebView. */
function openOut(url){
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}

/** An anchor that opens in the in-app browser rather than navigating away.

   Only inside Capacitor is the click intercepted. In a browser the anchor is
   left to be an anchor: taking the tap away from the browser and handing the
   URL back to it through script is exactly what stops working once the app is
   installed to a home screen. */
function link(text, url, cls){
  const a = el('a', cls, text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.Browser)
    a.onclick = e => { e.preventDefault(); e.stopPropagation(); openLink(url); };
  return a;
}

function toast(msg){
  const t=$('#toast'); t.textContent=msg; t.hidden=false;
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, 1900);
}

/* ── persistent state ─────────────────────────────────────────────────── */
const LS = {
  get(k, d){ try{ const v=localStorage.getItem('kls.'+k); return v==null?d:JSON.parse(v);}catch(e){return d;} },
  set(k, v){ try{ localStorage.setItem('kls.'+k, JSON.stringify(v)); }catch(e){} }
};

const HL = [
  {id:1, name:'Sun',    css:'var(--h1)'},
  {id:2, name:'Olive',  css:'var(--h2)'},
  {id:3, name:'Sky',    css:'var(--h3)'},
  {id:4, name:'Rose',   css:'var(--h4)'},
  {id:5, name:'Iris',   css:'var(--h5)'},
];

const State = {
  packs: {},                       // id -> pack (loaded lazily)
  manifest: {packs:[]},            // the books shipped inside the app
  catalog: LS.get('catalog', null),// the published library, fetched from the web
  appInfo: null,                   // this build's own name/version, native only
  versions: {},                    // id -> version actually stored on this device
  installed: LS.get('installed', []),
  prefs: LS.get('prefs', {theme:'light', size:19, lh:1.62, showFn:true, dropcap:true}),
  marks: LS.get('marks', {highlights:{}, bookmarks:[]}),
  lex: null,
  topics: [],                      // the teaching handouts, bundled with the app
  topic: null, tblocks: [],        // the study being read, flattened for selection
  mode: 'book',                    // 'book' or 'topic' - which reader owns the verse bar
  book: null, chapter: null, view:'library', selected:[],
  history: [],
};

const saveMarks = () => LS.set('marks', State.marks);
const savePrefs = () => LS.set('prefs', State.prefs);
const vkey = (b,c,v) => `${b}:${c}:${v}`;

/* ── pack storage (IndexedDB; packs are ~1 MB each) ───────────────────── */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('kls', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('packs');
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('packs', mode), s = t.objectStore('packs');
      const q = fn(s);
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get:  id       => tx('readonly',  s => s.get(id)),
    put:  (id, v)  => tx('readwrite', s => s.put(v, id)),
    del:  id       => tx('readwrite', s => s.delete(id)),
    keys: ()       => tx('readonly',  s => s.getAllKeys()),
  };
})();

async function loadPack(id){
  if (State.packs[id]) return State.packs[id];
  const p = await DB.get(id);
  if (p) State.packs[id] = p;
  return p;
}

/* ── the published library ────────────────────────────────────────────────
   Books finished after this build shipped are listed in a catalogue file on the
   web. The app only ever hard-codes the address of that one file (it comes down
   in packs/manifest.json, written by export_pack.py); every book URL is read out
   of the catalogue itself. So a book moving host is an edit to the catalogue,
   not a new release of the app.

   The catalogue is optional in every sense: it is fetched without blocking boot,
   the last good copy is kept in localStorage so the Library still shows what is
   available on a plane, and a book already on the device never depends on it. */
const CATALOG_TIMEOUT = 8000;

async function fetchCatalog(){
  const base = State.manifest && State.manifest.catalog;
  if (!base) return null;
  // GitHub's raw CDN caches for a few minutes; the timestamp defeats that so
  // "Check for new books" means what it says.
  const url = base + (base.includes('?') ? '&' : '?') + 'ts=' + Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CATALOG_TIMEOUT);
  try {
    const r = await fetch(url, {cache:'no-store', signal: ctl.signal});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const cat = await r.json();
    if (!cat || !Array.isArray(cat.packs)) throw new Error('not a catalogue');
    cat.fetchedAt = Date.now();
    State.catalog = cat;
    LS.set('catalog', cat);
    return cat;
  } catch(e){
    console.warn('catalogue unavailable', e);
    return null;
  } finally { clearTimeout(timer); }
}

/* The bundled manifest and the catalogue, reconciled into one list for the
   Library. A catalogue entry only displaces the shipped one when it is actually
   newer, so a stale or malformed catalogue can never downgrade a bundled book —
   and `file` and `bundled` always survive, because they are what the offline
   fallback installs from. */
function libraryEntries(){
  const out = new Map();
  for (const p of State.manifest.packs) out.set(p.id, Object.assign({}, p));

  const app = State.manifest.packFormat || 1;
  for (const p of (State.catalog && State.catalog.packs) || []){
    if (!p || !p.id || !p.url) continue;
    if ((p.packFormat || 1) > app) continue;      // needs a newer app than this
    const cur = out.get(p.id);
    if (!cur){ out.set(p.id, Object.assign({}, p, {remote:true})); continue; }
    if ((p.version || 0) > (cur.version || 0))
      out.set(p.id, Object.assign({}, cur, p,
                                  {bundled: cur.bundled, file: cur.file, remote:true}));
  }
  return [...out.values()];
}

/** What each installed book is actually at, read from storage rather than
    assumed — the Update badge is only honest if it compares against this. */
async function readInstalledVersions(){
  const out = {};
  for (const id of State.installed){
    try {
      const p = State.packs[id] || await DB.get(id);
      if (p) out[id] = p.version || 1;
    } catch(e){ /* unreadable; treated as unknown, never as up to date */ }
  }
  return out;
}

/* ── app updates ──────────────────────────────────────────────────────────
   The catalogue carries the published APK alongside the books, so the app can
   notice when a newer build exists. It cannot install it: Android will not let
   a sideloaded app replace itself silently, and asking for that permission is
   not worth it here. So this offers the download and the reader taps the file
   to install, exactly as they did the first time. */
async function readAppInfo(){
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (!(P && P.App && P.App.getInfo)) return null;   // a browser has no build number
  try { return await P.App.getInfo(); } catch(e){ return null; }
}

function renderAppUpdate(){
  const box = $('#app-update');
  if (!box) return;
  box.hidden = true; box.innerHTML = '';

  const pub = State.catalog && State.catalog.app;
  const info = State.appInfo;
  if (!pub || !pub.url || !info) return;

  const have = parseInt(info.build, 10);
  if (!isFinite(have) || !(pub.versionCode > have)) return;

  box.append(el('h4', null, 'App update available'));
  box.append(el('p', null,
    `Version ${pub.version} — you have ${info.version}. ` +
    `${(pub.bytes/1048576).toFixed(1)} MB download.`));
  const b = el('button', 'go solid', 'Download');
  b.onclick = () => {
    openLink(pub.url);
    toast('Open the downloaded file to install');
  };
  box.append(b);
  box.hidden = false;
}

const isUpdatable = p => !!(
  State.installed.includes(p.id) &&
  // an unknown stored version means unreadable, not up to date — say nothing
  // rather than promise an update that might do no such thing
  State.versions[p.id] != null &&
  (p.version || 1) > State.versions[p.id] &&
  (p.url || p.bundled));

async function refreshCatalog(opts={}){
  const btn = $('#btn-refresh');
  if (btn && !opts.quiet){ btn.disabled = true; btn.textContent = 'Checking…'; }
  const cat = await fetchCatalog();
  if (btn){ btn.disabled = false; btn.textContent = 'Check for new books'; }
  renderLibrary();

  if (!opts.quiet){
    if (!cat){ toast('Could not reach the library — check your connection'); return null; }
    const entries = libraryEntries();
    const fresh = entries.filter(p => !State.installed.includes(p.id) && p.remote).length;
    const updates = entries.filter(isUpdatable).length;
    const bits = [];
    if (fresh)   bits.push(`${fresh} new book${fresh>1?'s':''}`);
    if (updates) bits.push(`${updates} update${updates>1?'s':''}`);
    toast(bits.length ? bits.join(' and ') + ' available' : 'Everything is up to date');
  }
  return cat;
}

/* ── boot ─────────────────────────────────────────────────────────────── */
async function boot(){
  const msg = $('#boot-msg'), bar = $('#boot-bar');
  const step = (t, pct) => { msg.textContent = t; bar.style.width = pct+'%'; };

  applyPrefs();
  step('Reading the library index…', 15);
  try {
    State.manifest = await (await fetch('packs/manifest.json', {cache:'no-store'})).json();
  } catch(e){ State.manifest = {packs:[]}; }

  const keys = await DB.keys().catch(()=>[]);
  State.installed = State.installed.filter(id => keys.includes(id));

  // Install the bundled books on first run, and — just as important — replace any
  // already-installed book whose copy inside the app is newer. Without the version
  // check a pack cached in IndexedDB would keep its old content forever: after the
  // dead commentary links were corrected the files were right but the app still
  // served the stale pack it had stored on first launch.
  for (const b of State.manifest.packs){
    const have = State.installed.includes(b.id);
    if (!have && !b.bundled) continue;        // optional books wait to be added
    let stored = 0;
    if (have){
      try {
        const cur = await DB.get(b.id);
        stored = (cur && cur.version) || 0;
      } catch(e){ stored = 0; }
      if (stored >= (b.version || 1)) continue;
    }
    step(`${have ? 'Updating' : 'Installing'} ${b.title}…`, 45);
    try {
      const pack = await (await fetch('packs/'+b.file, {cache:'no-store'})).json();
      await DB.put(b.id, pack);
      if (!have) State.installed.push(b.id);
      if (have) console.info(`updated ${b.id}: v${stored} -> v${pack.version}`);
    } catch(e){ console.warn('pack install failed', b.id, e); }
  }
  LS.set('installed', State.installed);
  State.versions = await readInstalledVersions();
  State.appInfo = await readAppInfo();

  step('Opening…', 90);
  await loadTopics();
  bindUI();
  renderLibrary();

  // Deliberately not awaited. The app must open at the same speed with no
  // network at all, so the catalogue arrives late and re-renders the Library
  // when it does.
  refreshCatalog({quiet:true});

  // A shared link names the study it was shared for, and that wins over
  // wherever this device happened to leave off.
  const wanted = readHash();
  const last = LS.get('last', null);
  if (wanted && State.topics.some(t => t.id === wanted)){
    await openTopic(wanted);
  } else if (last && State.installed.includes(last.book)){
    await openBook(last.book, true);
    if (last.chapter) await openChapter(last.chapter, last.verse);
  } else {
    go('library');
  }

  step('Ready', 100);
  setTimeout(()=>{ $('#boot').remove(); $('#topbar').hidden=false; $('#tabbar').hidden=false; }, 180);
}

/* ── prefs ────────────────────────────────────────────────────────────── */
function applyPrefs(){
  const p = State.prefs;
  document.documentElement.dataset.theme = p.theme;
  document.documentElement.style.setProperty('--reading', p.size+'px');
  document.documentElement.style.setProperty('--lh', p.lh);
  document.body.classList.toggle('no-dropcap', !p.dropcap);
}

/* ── navigation ───────────────────────────────────────────────────────── */
const VIEWS = ['library','books','topics','connect','book','front','read','search','marks','lex','topic'];
function go(view, opts={}){
  if (State.view !== view && !opts.replace) State.history.push(State.view);
  State.view = view;
  // both readers own the bar; everywhere else it is dismissed
  if (view !== 'read' && view !== 'topic') hideVerseBar();
  if (view !== 'topic') clearHash();
  const reading = view === 'read';
  $('#prev-ch').hidden = !reading;
  $('#next-ch').hidden = !reading;
  VIEWS.forEach(v => $('#view-'+v).classList.toggle('on', v===view));
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.go===view));
  $('#btn-back').hidden = ['library','search','marks','lex'].includes(view);
  $('#btn-chapters').hidden = view!=='read';
  window.scrollTo(0, opts.keepScroll ? window.scrollY : 0);
  setTitle(view);
}
function back(){
  const prev = State.history.pop() || 'library';
  State.view = null; go(prev, {replace:true});
}
function setTitle(view){
  const b = State.book, t=$('#top-title'), s=$('#top-sub');
  const map = {library:'Library', books:'Bible Study', topics:'Further Study',
               connect:'Connect with us', search:'Search', marks:'Marks', lex:'Concordance'};
  if (map[view]) { t.textContent = map[view]; s.textContent=''; return; }
  if (view==='book'){ t.textContent=b?b.title:''; s.textContent=b?`${b.chapterCount} chapters`:''; return; }
  if (view==='front'){ t.textContent=b?b.title:''; s.textContent='Front matter'; return; }
  if (view==='topic'){ const s2 = State.topic;
    t.textContent = s2 ? s2.title : 'Topic Study';
    s.textContent = s2 ? (s2.subtitle || 'Topic study') : ''; return; }
  if (view==='read'){ t.textContent = b? `${b.title} ${State.chapter}` : '';
    const ch = currentChapter(); s.textContent = ch? ch.title : ''; }
}

/* ── ministry links, and how Further Study is grouped ─────────────────────
   These live here rather than in topics.json because that file is generated:
   a rebuild replaces it, and anything hand-added to it is lost. A study whose
   id is not listed below still shows up, under "More studies" at the end. */
const MINISTRY = {
  youtube:   'https://www.youtube.com/@MichaelBenYahKingdomLife777',
  // The uploads player needs the channel ID, not the handle. Fill this in with
  // the UC… id and the YouTube panel switches from a link card to a real
  // in-app player. Leave it empty and the card is shown instead.
  channelId: 'UCgDBnLbtkIr_LAyEarUZYXA',
  facebookPages: [
    ['Michael', 'https://www.facebook.com/MichaelBenYah777'],
    ['Rebekah', 'https://www.facebook.com/77rainbows'],
  ],
  email:     'michaelpeccia@kingdomlifeministy.com',
  support: [
    ['GoFundMe',          'https://gofund.me/bb1986c2f'],
    ['Kingdom Life Gear', 'https://kingdomlifegear.etsy.com'],
    ['Venmo',             'https://venmo.com/u/Michael-Peccia'],
    ['Cash App',          'https://cash.app/$mikepeccia'],
  ],
};

const TOPIC_SECTIONS = [
  ['Who Yahshua Is',               ['aleph-and-tav', 'yahshua-is-the-father']],
  ['The Covenant and Who You Are', ['the-marriage-covenant', 'who-you-are']],
  ['Marriage and Family',          ['husbands-love-your-wives']],
  ['The Sabbath',                  ['the-seventh-day', 'sabbath-fire-and-food']],
  ['Appointed Times',              ['yom-teruah']],
  ['Set Apart Living',             ['why-we-dont-eat-pig']],
];

/* Two studies that name each other as companions on their own title pages. */
const TOPIC_COMPANION = {
  'the-marriage-covenant': 'who-you-are',
  'who-you-are':           'the-marriage-covenant',
};

/* ── library ──────────────────────────────────────────────────────────── */
function renderLibrary(){
  const inst = $('#installed-list'), avail = $('#available-list');
  inst.innerHTML=''; avail.innerHTML='';

  const entries = libraryEntries();
  const byId = Object.fromEntries(entries.map(p=>[p.id,p]));
  const installed = State.installed.map(id => byId[id]).filter(Boolean);
  const others = entries.filter(p => !State.installed.includes(p.id));

  if (!installed.length) inst.append(el('p','empty','No books installed yet.'));
  installed.forEach(p => {
    const stale = isUpdatable(p);
    const c = el('div','card');
    c.append(el('i','spine'));
    const m = el('div','meta');
    m.append(el('h4',null,p.title),
             el('p',null,`${p.chapters} chapters · ${(p.verses||0).toLocaleString()} verses · ${p.footnotes} footnotes · ${p.translation}`));
    if (stale) m.append(el('p','badge','Updated edition available'));
    c.append(m);
    if (stale){
      const u = el('button','go solid','Update');
      u.onclick = () => installPack(p, u, 'update');
      c.append(u);
    }
    const b = el('button', stale ? 'go' : 'go solid', 'Open');
    b.onclick = () => openBook(p.id);
    c.append(b);
    c.oncontextmenu = e => { e.preventDefault(); confirmRemove(p); };
    inst.append(c);
  });

  if (!others.length) avail.append(el('p','empty','Everything available is installed.'));
  others.forEach(p => {
    const c = el('div','card');
    c.append(el('i','spine'));
    const m = el('div','meta');
    const size = p.bytes ? ` · ${(p.bytes/1048576).toFixed(1)} MB download` : '';
    m.append(el('h4',null,p.title), el('p',null,`${p.chapters} chapters${size}`));
    c.append(m);
    const b = el('button','go','Install');
    b.onclick = () => installPack(p, b);
    c.append(b);
    avail.append(c);
  });

  $('#store-hint').textContent = others.length
    ? 'Installed books are stored on this device and read offline.'
    : 'More books will appear here as they are published.';

  renderTopics();
  renderAppUpdate();
  renderHubCounts();

  const when = State.catalog && State.catalog.fetchedAt;
  $('#catalog-hint').textContent = when
    ? 'Library list last checked ' + relativeTime(when) + '.'
    : 'The list of available books is fetched when you are online.';
}

/* The two hub buttons say what is actually behind them, so the front page is
   not two unlabelled doors. */
function renderHubCounts(){
  const nb = State.installed.length, nt = State.topics.length;
  const b = $('#hub-books-sub'), t = $('#hub-topics-sub');
  if (b) b.textContent = nb
    ? `${nb} book${nb===1?'':'s'} on this device`
    : 'The book studies, none installed yet';
  if (t) t.textContent = nt
    ? `${nt} teaching handout${nt===1?'':'s'}`
    : 'The teaching handouts';
}

function relativeTime(ts){
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return mins + (mins===1 ? ' minute ago' : ' minutes ago');
  const hrs = Math.round(mins/60);
  if (hrs < 24)    return hrs + (hrs===1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs/24);
  return days + (days===1 ? ' day ago' : ' days ago');
}

/* Install or replace a book. The file may now come off the internet rather than
   out of the APK, so everything about it is checked before it is allowed to
   overwrite what is already on the device. */
async function installPack(entry, btn, mode){
  const updating = mode === 'update';
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = updating ? 'Updating…' : 'Installing…';
  try {
    const url = entry.url || ('packs/' + entry.file);
    const r = await fetch(url, {cache:'no-store'});
    if (!r.ok) throw new Error('the download failed (HTTP ' + r.status + ')');
    const pack = await r.json();

    if (!pack || !Array.isArray(pack.chapters) || !pack.chapters.length)
      throw new Error('that file is not a book');
    if (pack.id !== entry.id)
      throw new Error('the library list and the file disagree');
    if ((pack.packFormat || 1) > (State.manifest.packFormat || 1))
      throw new Error('this book needs a newer version of the app');

    await DB.put(entry.id, pack);
    if (!State.installed.includes(entry.id)) State.installed.push(entry.id);
    LS.set('installed', State.installed);
    State.packs[entry.id] = pack;
    State.versions[entry.id] = pack.version || 1;
    // Whatever is on screen is now holding the previous copy of this book, so
    // re-point it or the reader keeps showing the old text until a restart.
    if (State.book && State.book.id === entry.id) await openBook(entry.id, true);

    toast(entry.title + (updating ? ' updated' : ' installed'));
    renderLibrary();
  } catch(e){
    btn.disabled = false; btn.textContent = label;
    toast((updating ? 'Update' : 'Install') + ' failed — ' + e.message);
  }
}

function confirmRemove(entry){
  sheet(entry.title, body => {
    body.append(el('p',null,'Remove this book from the device? Your highlights and bookmarks are kept and will return if you reinstall.'));
    const b = el('button','primary','Remove book');
    b.onclick = async () => {
      await DB.del(entry.id);
      State.installed = State.installed.filter(i=>i!==entry.id);
      delete State.packs[entry.id];
      LS.set('installed', State.installed);
      closeSheet(); renderLibrary(); toast('Removed');
    };
    body.append(b);
  });
}

/* ── book contents ────────────────────────────────────────────────────── */
async function openBook(id, quiet){
  const pack = await loadPack(id);
  if (!pack){ toast('That book is not installed'); return; }
  State.book = pack; State.chapter = null;
  $('#book-title').textContent = pack.title;
  $('#book-sub').textContent = pack.subtitle || '';
  $('#book-stats').innerHTML =
    `<div><b>${pack.chapterCount}</b>chapters</div>
     <div><b>${pack.verseCount.toLocaleString()}</b>verses</div>
     <div><b>${pack.footnoteCount}</b>footnotes</div>
     <div><b>${pack.translation}</b>text</div>`;

  const fl = $('#front-list'); fl.innerHTML='';
  (pack.front||[]).forEach((f,i) => {
    const b = el('button',null,f.title); b.onclick = () => openFront(i); fl.append(b);
  });

  const grid = $('#chapter-grid'); grid.innerHTML='';
  pack.chapters.forEach(ch => {
    const b = el('button',null,String(ch.num));
    if (readMarker(pack.id, ch.num)) b.classList.add('read');
    b.onclick = () => openChapter(ch.num);
    grid.append(b);
  });

  if (!quiet) go('book');
}

function readMarker(book, ch){
  const seen = LS.get('seen', {});
  return seen[book+':'+ch];
}
function markSeen(book, ch){
  const seen = LS.get('seen', {}); seen[book+':'+ch]=1; LS.set('seen', seen);
}

function openFront(i){
  const f = State.book.front[i];
  const box = $('#front-body'); box.innerHTML='';
  box.append(el('p','kicker', State.book.title));
  box.append(el('h2','chapter', f.title));
  f.sections.forEach(sec => {
    if (sec.heading){
      const h = el('h3'); h.style.cursor='default';
      h.append(el('span',null,sec.heading)); box.append(h);
    }
    sec.items.forEach(it => {
      if (it.type==='list'){
        const ul=el('ul');
        it.values.forEach(v => { const li=el('li'); li.innerHTML=inlineBold(v); ul.append(li); });
        box.append(ul);
      } else {
        const p=el('p'); p.innerHTML=inlineBold(it.value); box.append(p);
      }
    });
  });
  go('front');
}
const inlineBold = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/* ── reader ───────────────────────────────────────────────────────────── */
const currentChapter = () => State.book && State.book.chapters.find(c=>c.num===State.chapter);

/* The second reference table is named per book — "Messianic Connections" in
   Jeremiah, "Prophecy Fulfilled" in Matthew. Packs built before this key existed
   fall back to the Jeremiah wording. */
const label2 = () => (State.book && State.book.labels && State.book.labels.table2)
  || 'Messianic Connections';
const label2Note = () => (State.book && State.book.labels && State.book.labels.table2Note)
  || 'Messianic Connection';

async function openChapter(num, scrollToVerse){
  const pack = State.book; if(!pack) return;
  const ch = pack.chapters.find(c=>c.num===num); if(!ch) return;
  State.chapter = num; State.mode = 'book'; hideVerseBar();
  markSeen(pack.id, num);
  LS.set('last', {book:pack.id, chapter:num, verse:scrollToVerse||null});

  const box = $('#read-body'); box.innerHTML='';
  box.append(el('p','kicker', `${pack.title} ${num}`));
  box.append(el('h2','chapter', ch.title));

  box.append(sectionBlock('Introduction', open=true, panel => {
    panel.classList.add('intro');
    ch.intro.forEach(p => panel.append(el('p',null,p)));
  }));

  const scripture = sectionBlock(`${pack.title} ${num}:1–${ch.verseCount}`, true, panel => {
    for (let v=1; v<=ch.verseCount; v++){
      const text = ch.verses[String(v)]; if (text==null) continue;
      panel.append(renderVerse(pack, ch, v, text));
    }
  });
  box.append(scripture);

  box.append(sectionBlock('Key Notes', false, panel => {
    const ul=el('ul'); ch.keyNotes.forEach(n => ul.append(el('li',null,n))); panel.append(ul);
  }));
  box.append(sectionBlock('Key Cross-References', false, panel => {
    panel.append(refTable('Topic', ch.xrefs));
  }));
  box.append(sectionBlock(label2(), false, panel => {
    panel.append(refTable(State.book.labels && State.book.labels.table2Head || 'Connection',
                          ch.messianic));
  }));
  box.append(sectionBlock('For Further Study', false, panel => {
    const ul=el('ul');
    ch.further.forEach(f => {
      const li=el('li');
      li.append(link(f.name, f.url), document.createTextNode(' — '+f.desc)); ul.append(li);
    });
    panel.append(ul);
  }));

  const part = (pack.parts||[]).find(p => p.afterChapter===num);
  if (part) box.append(sectionBlock(part.title, false, panel => {
    const ul=el('ul'); part.items.forEach(t => ul.append(el('li',null,t))); panel.append(ul);
  }));

  const i = pack.chapters.findIndex(c=>c.num===num);
  const prev = i>0 ? pack.chapters[i-1] : null;
  const next = i<pack.chapters.length-1 ? pack.chapters[i+1] : null;
  $('#prev-ch').disabled = !prev;
  $('#next-ch').disabled = !next;
  $('#prev-num').textContent = prev ? prev.num : '';
  $('#next-num').textContent = next ? next.num : '';

  go('read');
  if (scrollToVerse){
    const n = box.querySelector(`.verse[data-v="${scrollToVerse}"]`);
    if (n) setTimeout(()=>n.scrollIntoView({block:'center'}), 60);
  }
}

function sectionBlock(title, open, fill){
  const s = el('section'); if(!open) s.classList.add('closed');
  const h = el('h3');
  h.append(el('span',null,title), el('span','tw','▾'));
  h.onclick = () => s.classList.toggle('closed');
  const panel = el('div','panel');
  fill(panel);
  s.append(h, panel);
  return s;
}

function refTable(head, rows){
  const t = el('table','tbl');
  const hr = el('tr'); hr.append(el('th',null,head), el('th',null,'References')); t.append(hr);
  rows.forEach(r => {
    const tr=el('tr'); tr.append(el('td',null,r.topic));
    const td=el('td');
    r.refs.forEach(ref => {
      const a=el('a','reflink',ref);
      a.href='#'; a.onclick = e => { e.preventDefault(); showRef(ref); };
      td.append(a);
    });
    tr.append(td); t.append(tr);
  });
  return t;
}

function renderVerse(pack, ch, v, text){
  const d = el('div','verse');
  d.dataset.v = v;
  const hl = State.marks.highlights[vkey(pack.id, ch.num, v)];
  if (hl) d.dataset.hl = hl;
  d.append(el('span','vn', String(v)));
  d.append(document.createTextNode(text));

  const notes = ch.footnotes[String(v)];
  if (notes && State.prefs.showFn){
    notes.forEach((n, i) => {
      if (i) d.append(el('span','fnm', ','));
      const m = el('span','fnm', String(n.n));
      m.onclick = e => { e.stopPropagation(); showFootnote(n); };
      d.append(m);
    });
  }
  if (State.marks.bookmarks.some(b => b.book===pack.id && b.chapter===ch.num && b.verse===v))
    d.append(el('span','bm','❏'));

  d.onclick = () => selectVerse(v, d);
  return d;
}

/* ── verse selection + marks ──────────────────────────────────────────────
   State.selected is a sorted array of verse numbers. Tapping toggles a verse in
   or out, so a passage can be highlighted or copied in one go, and the verses
   need not be next to each other. */
function selectVerse(v, node){
  const i = State.selected.indexOf(v);
  if (i >= 0){ State.selected.splice(i, 1); node.classList.remove('sel'); }
  else { State.selected.push(v); State.selected.sort((a,b)=>a-b); node.classList.add('sel'); }
  if (!State.selected.length){ hideVerseBar(); return; }
  showVerseBar();
}

function hideVerseBar(){
  State.selected = [];
  $('#verse-bar').hidden = true;
  $$('.verse.sel, .unit.sel').forEach(n=>n.classList.remove('sel'));
}

/** "3:1", "3:1-4", "3:1-3,7" - runs collapsed, gaps kept. */
function selectionRef(){
  const vs = State.selected;
  if (!vs.length) return '';
  const parts = [];
  let start = vs[0], prev = vs[0];
  for (let i = 1; i <= vs.length; i++){
    if (vs[i] === prev + 1){ prev = vs[i]; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = vs[i];
  }
  return `${State.book.title} ${State.chapter}:${parts.join(',')}`;
}

function showVerseBar(){
  const bar = $('#verse-bar');
  const vs = State.selected;
  const topic = State.mode === 'topic';
  const keyOf = i => topic ? topicKey(i) : vkey(State.book.id, State.chapter, i);

  $('#vb-ref').textContent = (topic ? topicSelectionLabel() : selectionRef())
    + (vs.length > 1 ? `  (${vs.length} ${topic ? 'paragraphs' : 'verses'})` : '');

  // A swatch reads as "on" only when every selected verse already carries it,
  // so a mixed selection shows none lit and the next tap sets them all alike.
  const ids = vs.map(keyOf).map(k => State.marks.highlights[k]);
  const shared = ids.every(x => x === ids[0]) ? ids[0] : null;

  const sw = $('#vb-colors'); sw.innerHTML='';
  HL.forEach(h => {
    const b = el('button'); b.style.background = h.css; b.title = h.name;
    if (shared===h.id) b.classList.add('on');
    b.onclick = () => setHighlight(shared===h.id ? null : h.id);
    sw.append(b);
  });

  // The concordance works on one verse at a time; say so by disabling it rather
  // than quietly acting on whichever verse happens to be first.
  const words = $('#vb-actions button[data-act="words"], .vb-actions button[data-act="words"]');
  if (words) words.disabled = topic || vs.length !== 1;

  bar.hidden = false;
}

function setHighlight(id){
  const topic = State.mode === 'topic';
  State.selected.forEach(v => {
    const k = topic ? topicKey(v) : vkey(State.book.id, State.chapter, v);
    if (id) State.marks.highlights[k]=id; else delete State.marks.highlights[k];
    const node = topic ? $(`.unit[data-i="${v}"]`) : $(`.verse[data-v="${v}"]`);
    if (node){ if(id) node.dataset.hl=id; else delete node.dataset.hl; }
  });
  saveMarks();
  showVerseBar();
}

function verseText(v){
  const ch = currentChapter(); return ch ? ch.verses[String(v)] : '';
}

const SUP = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'};
const sup = n => String(n).replace(/\d/g, d => SUP[d]);

/** Selected verses as one paragraph, each opened by a superscript number. */
function selectionText(){
  const vs = State.selected;
  if (vs.length === 1) return verseText(vs[0]);
  return vs.map(v => `${sup(v)} ${verseText(v)}`).join(' ');
}

function verseAction(act){
  if (State.mode === 'topic'){ topicAction(act); return; }
  const vs = State.selected;
  if (!vs.length) return;
  const first = vs[0];
  const ref = selectionRef();

  if (act==='bookmark'){
    // A bookmark is a place to return to, so it hangs on the first verse - but
    // it carries the whole range in its label.
    const i = State.marks.bookmarks.findIndex(b=>b.book===State.book.id&&b.chapter===State.chapter&&b.verse===first);
    if (i>=0){ State.marks.bookmarks.splice(i,1); toast('Bookmark removed'); }
    else { State.marks.bookmarks.unshift({book:State.book.id,bookTitle:State.book.title,
             chapter:State.chapter, verse:first, ref, note:'', at:Date.now()}); toast('Bookmarked'); }
    saveMarks(); openChapter(State.chapter, first);
  }
  else if (act==='note') noteSheet(first, ref);
  else if (act==='copy'){
    const t = `${ref} — ${selectionText()} (WEB)`;
    navigator.clipboard?.writeText(t).then(
      ()=>toast(vs.length>1 ? `Copied ${vs.length} verses` : 'Copied'),
      ()=>toast('Could not copy'));
  }
  else if (act==='words'){ if (vs.length===1) wordsSheet(first, ref); }
  else if (act==='clear'){ setHighlight(null); hideVerseBar(); toast('Cleared'); }
}

function noteSheet(v, ref){
  const existing = State.marks.bookmarks.find(b=>b.book===State.book.id&&b.chapter===State.chapter&&b.verse===v);
  sheet(ref, body => {
    const f = el('div','field');
    f.append(el('label',null,'Your note'));
    const ta = el('textarea'); ta.value = existing?existing.note:''; ta.placeholder='What did you see here?';
    f.append(ta); body.append(f);
    const b = el('button','primary','Save note');
    b.onclick = () => {
      let bm = existing;
      if (!bm){ bm = {book:State.book.id, bookTitle:State.book.title, chapter:State.chapter,
                      verse:v, ref, note:'', at:Date.now()}; State.marks.bookmarks.unshift(bm); }
      bm.note = ta.value.trim(); bm.at = Date.now();
      bm.ref = ref;                 // keep the label in step with the range noted
      saveMarks(); closeSheet(); openChapter(State.chapter, v); toast('Saved');
    };
    body.append(b);
  });
}

/* ── footnotes and reference lookup ───────────────────────────────────── */
function showFootnote(n){
  const noteLabel = n.kind==='mc' ? label2Note() : 'Cross-Reference';
  sheet(noteLabel, body => {
    body.append(el('span','kind'+(n.kind==='mc'?' mc':''), noteLabel));
    n.cites.forEach(c => {
      const h = el('p','cite');
      h.append(link(c.ref+' (WEB)', c.url)); body.append(h);
      body.append(el('p','vtext', c.text || 'See passage in context.'));
    });
    const why = el('p','why'); why.innerHTML = '<b>Why it connects:</b> '+esc(n.why);
    body.append(why);
  });
}

function showRef(ref){
  // look for the text anywhere in the installed pack's footnote citations
  let text=null;
  outer: for (const ch of State.book.chapters){
    for (const k in ch.footnotes) for (const n of ch.footnotes[k])
      for (const c of n.cites) if (c.ref===ref && c.text){ text=c.text; break outer; }
  }
  const m = ref.match(/^(.+?)\s+(\d+):/);
  const local = m && m[1]===State.book.title;
  sheet(ref, body => {
    body.append(el('p','vtext', text || 'This passage is not carried inside the installed book.'));
    const row = el('div','row');
    if (local){
      const b = el('button','ghost','Go to passage');
      b.onclick = () => { closeSheet(); openChapter(+m[2], +(ref.split(':')[1]||'').split(/[-–]/)[0]); };
      row.append(b);
    }
    const a = link('Open in BibleGateway',
      'https://www.biblegateway.com/passage/?search='+encodeURIComponent(ref)+'&version=WEB', 'ghost');
    a.style.textAlign='center'; a.style.textDecoration='none';
    row.append(a); body.append(row);
  });
}

/* ── words / concordance ──────────────────────────────────────────────── */

/* Strong's was written in 1890 and renders the divine name "Jehovah", never
   "Yahweh"; its transliterations are also full of diacritics (Yᵉhôvâh). This
   app speaks Yahweh and people type plain letters, so both sides of a search
   get flattened and a few names are given their modern equivalents. */
const DIACRITIC = {'ᵉ':'e','ᵊ':'e','ᵃ':'a','ᵒ':'o','ᵘ':'u','ⁱ':'i','ᵛ':'v',
                   'ʼ':'','ʻ':'','ʾ':'','ʿ':'','’':'','‘':'','´':'','`':'','ç':'s','Ç':'s'};
function flat(s){
  return String(s)
    .replace(/[ᵉᵊᵃᵒᵘⁱᵛʼʻʾʿ’‘´`çÇ]/g, c => DIACRITIC[c] ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Strong's spells long vowels with a glide - ʼĕlôhîym, shâlôwm, rûwach -
    // and writes the divine name with a J. Collapse both so that what a reader
    // actually types reaches the entry.
    .replace(/iy/g, 'i').replace(/ow/g, 'o').replace(/uw/g, 'u')
    .replace(/^j/, 'y').replace(/\bj/g, 'y');
}

const LEX_ALIAS = {
  yahweh:['jehovah'], yhwh:['jehovah'], yah:['jehovah','jah'],
  jehovah:['yahweh'], lord:['jehovah','adonai'],
  yahshua:['jesus','joshua'], yeshua:['jesus','joshua'], jesus:['yahshua'],
  elohim:['god'], eloah:['god'], adonai:['lord'],
  messiah:['christ','anointed'], christ:['messiah','anointed'],
  torah:['law'], shalom:['peace'], chesed:['mercy','kindness','lovingkindness'],
  ruach:['spirit','wind','breath'], nephesh:['soul','life'],
  shabbat:['sabbath'], pesach:['passover'], goyim:['nations','gentile'],
  satan:['adversary'], sheol:['grave','hell','pit'],
};

function expandQuery(q){
  const terms = new Set([q]);
  (LEX_ALIAS[q] || []).forEach(t => terms.add(t));
  for (const [k, vals] of Object.entries(LEX_ALIAS))
    if (vals.includes(q)) terms.add(k);
  return [...terms];
}
async function loadLex(){
  if (State.lex) return State.lex;
  try { State.lex = await (await fetch('packs/strongs.json')).json(); }
  catch(e){
    try { State.lex = await (await fetch('packs/strongs-core.json')).json(); }
    catch(e2){ State.lex = {entries:{}, index:{}, note:'No lexicon installed.'}; }
  }
  return State.lex;
}

function tagsFor(chapter, verse){
  const s = State.book.strongs || {};
  return s[chapter+':'+verse] || null;
}

async function wordsSheet(v, ref){
  const lex = await loadLex();
  const text = verseText(v);
  const words = text.split(/(\s+)/);
  const tags = tagsFor(State.chapter, v);
  sheet(ref, body => {
    body.append(el('p','hint', tags
      ? 'Tap a word to open its Hebrew or Greek entry.'
      : 'This book has no word-level tagging installed, so tapping searches the lexicon by meaning.'));
    const p = el('p','vtext');
    let wi = -1;
    words.forEach(tok => {
      if (/^\s+$/.test(tok)){ p.append(document.createTextNode(tok)); return; }
      wi++;
      const clean = tok.replace(/[^A-Za-z'-]/g,'');
      const span = el('span','w', tok);
      const tag = tags && tags.find(t => t[0]===wi);
      if (tag) span.classList.add('tag');
      if (clean){
        const idx = wi;
        span.onclick = () => tag ? showStrong(tag[1]) : lexSearch(clean, true);
      }
      p.append(span);
    });
    body.append(p);
  });
}

async function showStrong(num){
  const lex = await loadLex();
  const e = lex.entries[num];
  sheet(num, body => {
    if (!e){ body.append(el('p','hint', `No entry for ${num} in the installed lexicon.`)); return; }
    const head = el('div','lexhead');
    head.append(el('span','lexlemma', e.lemma||''),
                el('span','lextr', e.translit||''),
                el('span','lexnum', num));
    body.append(head);
    if (e.pron) body.append(el('p','hint','Pronounced '+e.pron));
    if (e.pos)  body.append(el('p','hint', e.pos));
    if (e.gloss) body.append(el('p','vtext', e.gloss));
    if (e.def)   body.append(el('p',null, e.def));
    if (e.derivation) body.append(el('p','why', e.derivation));
    const b = el('button','primary','Find this word in the text');
    b.onclick = () => { closeSheet(); go('lex'); $('#lex-q').value = num; runLexSearch(); };
    body.append(b);
  });
}

function lexSearch(term, openView){
  if (openView){ closeSheet(); go('lex'); }
  $('#lex-q').value = term; runLexSearch();
}

async function runLexSearch(){
  const lex = await loadLex();
  const q = $('#lex-q').value.trim().toLowerCase();
  const lang = ($('#lex-scope button.on')||{}).dataset?.lang || 'all';
  const box = $('#lex-results'); box.innerHTML='';
  if (!q){ $('#lex-count').textContent = `${Object.keys(lex.entries).length} entries installed.`; return; }

  const terms = expandQuery(q).map(flat);
  const hits=[];
  for (const num in lex.entries){
    if (lang!=='all' && num[0]!==lang) continue;
    const e = lex.entries[num];
    const tr = flat(e.translit||''), gl = flat(e.gloss||''), df = flat(e.def||'');
    const hay = `${num.toLowerCase()} ${e.lemma||''} ${tr} ${gl} ${df}`;
    const term = terms.find(t => hay.includes(t));
    if (term){
      let score = 0;
      if (num.toLowerCase()===term) score+=100;
      if (tr===term) score+=60;
      else if (tr.startsWith(term)) score+=40;
      // The usage list is what the word is actually translated as, so a whole-word
      // hit there outranks the definition. berith's definition never says
      // "covenant" - its usage list does, and that is the entry people want.
      if (new RegExp('\\b'+term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(df)) score+=30;
      if (gl.includes(term)) score+=12;
      if (term!==flat(q)) score-=5;          // matched via an alias
      // Strong's capitalises proper names, so "Cheçed, an Israelite" is a person
      // and "chêçêd" is loving kindness. Demote the people firmly.
      if (/^[A-Z]/.test(e.translit||'')) score-=30;
      hits.push({num, e, score});
    }
  }
  hits.sort((a,b)=>b.score-a.score || a.num.localeCompare(b.num));
  $('#lex-count').textContent = hits.length ? `${hits.length} entries` : 'No entries match.';
  hits.slice(0,200).forEach(h => {
    const r = el('div','res');
    r.append(el('p','ref', `${h.num} · ${h.e.translit||''}`));
    const p = el('p'); p.innerHTML = `<strong>${esc(h.e.lemma||'')}</strong> — ${esc(h.e.gloss||'')}`;
    r.append(p);
    if (h.e.def) r.append(el('p','sub', h.e.def.slice(0,180)));
    r.onclick = () => showStrong(h.num);
    box.append(r);
  });
  if (!hits.length && lex.note) box.append(el('p','empty', lex.note));
}

/* ── search ───────────────────────────────────────────────────────────────
   The open book is searched as it always was. The handouts are searched too,
   always: they are inside the app, they never have to be installed, and
   somebody typing "Yom Teruah" should find it whether or not a book happens to
   be open. */
function runSearch(){
  const q = $('#q').value.trim();
  const scope = ($('#search-scope button.on')||{}).dataset?.scope || 'all';
  const box = $('#search-results'); box.innerHTML='';
  if (q.length < 2){ $('#search-count').textContent=''; return; }

  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'ig');
  const hits=[];

  if (State.book){
    for (const ch of State.book.chapters){
      if (scope!=='study'){
        for (const v in ch.verses){
          const t = ch.verses[v];
          if (t.match(rx)) hits.push({kind:'verse', ch:ch.num, v:+v, text:t});
          rx.lastIndex=0;
        }
      }
      if (scope!=='verses'){
        ch.intro.forEach(p => { if (p.match(rx)) hits.push({kind:'Introduction', ch:ch.num, text:p}); rx.lastIndex=0; });
        ch.keyNotes.forEach(n => { if (n.match(rx)) hits.push({kind:'Key note', ch:ch.num, text:n}); rx.lastIndex=0; });
      }
      if (hits.length>400) break;
    }
  }

  if (scope!=='verses'){
    outer:
    for (const t of State.topics){
      for (const sec of t.sections) for (const b of sec.blocks){
        const text = blockText(b);
        if (text.match(rx)) hits.push({kind:'topic', topic:t, k:b.k, text,
          label:`${t.title} · ${sec.heading || sec.kicker || 'Topic study'}`});
        rx.lastIndex=0;
        if (hits.length>500) break outer;
      }
    }
  }

  if (!hits.length && !State.book && !State.topics.length){
    box.append(el('p','empty','Open a book first.')); return;
  }
  $('#search-count').textContent = hits.length ? `${hits.length} result${hits.length>1?'s':''}` : 'Nothing found.';
  hits.slice(0,200).forEach(h => {
    const r = el('div','res');
    r.append(el('p','ref',
      h.kind==='topic' ? h.label
      : h.kind==='verse' ? `${State.book.title} ${h.ch}:${h.v}`
      : `${State.book.title} ${h.ch} · ${h.kind}`));
    const p = el('p');
    p.innerHTML = esc(h.text).replace(new RegExp(rx.source,'ig'), m=>`<mark>${m}</mark>`);
    r.append(p);
    r.onclick = h.kind==='topic'
      ? () => openTopicAt(topicBookId(h.topic.id), h.k)
      : () => openChapter(h.ch, h.v||null);
    box.append(r);
  });
}

/* ── marks view ───────────────────────────────────────────────────────────
   A mark belongs either to a book, keyed by chapter and verse, or to a topic
   study, keyed by the paragraph's own key. The id says which, and everything
   else here is the same list it always was. */
function markTitle(id){
  const t = topicOf(id);
  if (t) return t.title;
  const p = State.packs[id];
  return p ? p.title : id;
}
function markText(id, c, v){
  const t = topicOf(id);
  if (t){
    for (const s of t.sections) for (const b of s.blocks)
      if (b.k === v) return blockText(b);
    return 'This study has been revised since the mark was made.';
  }
  return (State.packs[id]?.chapters.find(ch => ch.num === +c)?.verses[String(v)]) || '';
}
async function openMark(id, c, v){
  if (isTopicId(id)) return openTopicAt(id, v);
  if (State.book?.id !== id) await openBook(id, true);
  openChapter(+c, +v);
}

function renderMarks(){
  const tab = ($('#marks-tabs button.on')||{}).dataset?.tab || 'bookmarks';
  const box = $('#marks-body'); box.innerHTML='';
  if (tab==='bookmarks'){
    const list = State.marks.bookmarks;
    if (!list.length){ box.append(el('p','empty','No bookmarks yet. Tap a verse or a paragraph, then Bookmark.')); return; }
    list.forEach((b,i) => {
      const r = el('div','res');
      r.append(el('p','ref', b.ref));
      const t = markText(b.book, b.chapter, b.verse);
      r.append(el('p',null, t.slice(0,180) + (t.length>180?'…':'')));
      if (b.note) r.append(el('p','sub','Note: '+b.note));
      r.onclick = () => openMark(b.book, b.chapter, b.verse);
      r.oncontextmenu = e => { e.preventDefault(); State.marks.bookmarks.splice(i,1); saveMarks(); renderMarks(); toast('Removed'); };
      box.append(r);
    });
  } else {
    const keys = Object.keys(State.marks.highlights);
    if (!keys.length){ box.append(el('p','empty','No highlights yet. Tap a verse or a paragraph, then choose a colour.')); return; }
    keys.sort((a,b)=>{ const [ab,ac,av]=a.split(':'), [bb,bc,bv]=b.split(':');
      return ab.localeCompare(bb) || (ac-bc) || String(av).localeCompare(String(bv)); });
    keys.forEach(k => {
      const [book, c, v] = k.split(':');
      const r = el('div','res');
      const swatch = HL.find(h=>h.id===State.marks.highlights[k]);
      r.style.borderLeft = '5px solid ' + (swatch ? swatch.css : 'var(--rule)');
      r.append(el('p','ref', isTopicId(book) ? markTitle(book) : `${markTitle(book)} ${c}:${v}`));
      const t = markText(book, c, v) || '(book not installed)';
      r.append(el('p',null, t.slice(0,200) + (t.length>200?'…':'')));
      r.onclick = () => openMark(book, c, v);
      r.oncontextmenu = e => { e.preventDefault(); delete State.marks.highlights[k]; saveMarks(); renderMarks(); };
      box.append(r);
    });
  }
}

function exportMarks(){
  const blob = new Blob([JSON.stringify(State.marks,null,1)], {type:'application/json'});
  const a = el('a'); a.href = URL.createObjectURL(blob);
  a.download = 'kingdom-life-marks.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  toast('Exported');
}
function importMarks(){
  const inp = el('input'); inp.type='file'; inp.accept='application/json';
  inp.onchange = () => {
    const f = inp.files[0]; if(!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        State.marks.highlights = Object.assign({}, State.marks.highlights, d.highlights||{});
        const seen = new Set(State.marks.bookmarks.map(b=>b.book+':'+b.chapter+':'+b.verse));
        (d.bookmarks||[]).forEach(b => { if(!seen.has(b.book+':'+b.chapter+':'+b.verse)) State.marks.bookmarks.push(b); });
        saveMarks(); renderMarks(); toast('Marks merged');
      } catch(e){ toast('That file could not be read'); }
    };
    fr.readAsText(f);
  };
  inp.click();
}

/* ── sheet ────────────────────────────────────────────────────────────── */
function sheet(title, fill){
  $('#sheet-title').textContent = title;
  const body = $('#sheet-body'); body.innerHTML='';
  fill(body);
  $('#sheet').hidden = false;
}
function closeSheet(){ $('#sheet').hidden = true; }

function settingsSheet(){
  sheet('Reading', body => {
    const themes = el('div','seg');
    [['light','Light'],['sepia','Sepia'],['dark','Dark']].forEach(([id,name]) => {
      const b = el('button',null,name);
      if (State.prefs.theme===id) b.classList.add('on');
      b.onclick = () => { State.prefs.theme=id; savePrefs(); applyPrefs();
        $$('button',themes).forEach(x=>x.classList.remove('on')); b.classList.add('on'); };
      themes.append(b);
    });
    body.append(el('p','hint','Theme'), themes);

    const mk = (label, key, min, max, stepv) => {
      const wrap = el('div','opt');
      wrap.append(el('span',null,label));
      const ctl = el('div','row'); ctl.style.marginTop='0';
      const minus = el('button','ghost','−'), plus = el('button','ghost','+');
      minus.onclick = () => { State.prefs[key]=Math.max(min, +(State.prefs[key]-stepv).toFixed(2)); savePrefs(); applyPrefs(); };
      plus.onclick  = () => { State.prefs[key]=Math.min(max, +(State.prefs[key]+stepv).toFixed(2)); savePrefs(); applyPrefs(); };
      ctl.append(minus, plus); wrap.append(ctl); return wrap;
    };
    body.append(mk('Text size','size',15,26,1));
    body.append(mk('Line spacing','lh',1.3,2.1,0.06));

    [['showFn','Show footnote markers'],['dropcap','Drop capitals']].forEach(([k,label]) => {
      const o = el('div','opt'); o.append(el('span',null,label));
      const b = el('button','ghost', State.prefs[k]?'On':'Off');
      b.onclick = () => { State.prefs[k]=!State.prefs[k]; savePrefs(); b.textContent=State.prefs[k]?'On':'Off';
        if (State.chapter) openChapter(State.chapter); };
      o.append(b); body.append(o);
    });

    body.append(el('p','hint','Scripture is the World English Bible, public domain. Study content © Kingdom Life.'));
  });
}

/* ── chapter picker ───────────────────────────────────────────────────── */
function chapterSheet(){
  sheet('Chapters', body => {
    const g = el('div','grid');
    State.book.chapters.forEach(ch => {
      const b = el('button',null,String(ch.num));
      if (ch.num===State.chapter) b.classList.add('here');
      else if (readMarker(State.book.id, ch.num)) b.classList.add('read');
      b.onclick = () => { closeSheet(); openChapter(ch.num); };
      g.append(b);
    });
    body.append(g);
  });
}


/* ── Topic Studies ────────────────────────────────────────────────────────
   The teaching handouts, read here rather than printed.

   They are not books, so they are not packs: there are no chapters, no verse
   numbers, and nothing to install. What they do share with the books is the
   part that matters - a reference you can tap, a paragraph you can colour, and
   a note of your own on any of it - so all of that is reused rather than
   rebuilt, and a handout's marks sit alongside a book's in Marks.

   A mark on a handout hangs on a key made from the paragraph's own words
   rather than its position, which is why correcting a typo in section two does
   not move somebody's highlight in section nine. */

const TOPIC_PREFIX = 't-';
const topicBookId  = id => TOPIC_PREFIX + id;
const isTopicId    = id => String(id).startsWith(TOPIC_PREFIX);
const topicOf      = id => State.topics.find(t => topicBookId(t.id) === id);

/* The handouts ship inside the app, so this is a local read and the Library
   has them before the first paint. A failure here costs the section and
   nothing else. */
async function loadTopics(){
  try {
    const d = await (await fetch('topics.json', {cache:'no-store'})).json();
    State.topics = Array.isArray(d && d.topics) ? d.topics : [];
  } catch(e){
    State.topics = [];
    console.warn('topic studies unavailable', e);
  }
}

/* Where this handout lives on the web, taken from the PDF's own address rather
   than hard-coded, so the domain is set in one place - the build - and the
   Android app shares the same links as the website. */
const topicSite = t => String(t.pdfUrl || '').replace(/handouts\/.*$/, '');
const topicUrl  = t => topicSite(t) + '#topic/' + t.id;

function blockText(b){
  if (b.t === 'l')   return (b.items || []).join('  ');
  if (b.t === 'tbl') return (b.rows || []).map(r => `${r.topic}: ${r.v}`).join('  ');
  return [b.title, b.v].filter(Boolean).join(' — ');
}

/* ── the Further Study screen ─────────────────────────────────────────── */
function renderTopics(){
  const box = $('#topic-sections');
  if (!box) return;
  box.innerHTML = '';
  if (!State.topics.length){
    box.append(el('p','empty','No topic studies in this build.'));
    return;
  }

  const byId   = Object.fromEntries(State.topics.map(t => [t.id, t]));
  const placed = new Set();
  const groups = TOPIC_SECTIONS.map(([name, ids]) => {
    const list = ids.map(id => byId[id]).filter(Boolean);
    list.forEach(t => placed.add(t.id));
    return [name, list];
  });

  // anything the grouping does not know about is still reachable
  const rest = State.topics.filter(t => !placed.has(t.id));
  if (rest.length) groups.push(['More studies', rest]);

  groups.forEach(([name, list]) => {
    if (!list.length) return;
    box.append(el('h3','rule', name));
    const cards = el('div','cards');
    list.forEach(t => cards.append(topicCard(t)));
    box.append(cards);
  });
}

function topicCard(t){
  const c = el('div','card');
  c.append(el('i','spine'));
  const m = el('div','meta');
  m.append(el('h4', null, t.title));
  if (t.subtitle) m.append(el('p','topic-sub-line', t.subtitle));
  m.append(el('p', null,
    `${t.sections.length} parts \u00b7 about ${t.minutes} min \u00b7 PDF ${Math.round(t.pdfBytes/1024)} KB`));
  const mateId = TOPIC_COMPANION[t.id];
  const mate   = mateId && State.topics.find(x => x.id === mateId);
  if (mate) m.append(el('p','companion', 'Companion study: ' + mate.title));
  c.append(m);
  const b = el('button','go solid','Read');
  b.onclick = () => openTopic(t.id);
  c.append(b);
  return c;
}

/* ── connect with us ──────────────────────────────────────────────────────
   Facebook and YouTube both refuse to be framed by their normal page URLs, so
   the only way to keep somebody inside the app is each platform's own embed:
   the uploads player and the Page Plugin. Mail has no embed at all, so that
   panel copies the address and hands off to whatever mail app is installed.
   Nothing here loads until the panel is opened, so the front page makes no
   third-party requests. */
function connectSheet(){
  sheet('Connect with us', body => {
    body.append(el('p','hint',
      'YouTube and Facebook open inside the app. Email hands off to your mail app.'));
    const act = (label, cls, panel) => {
      const b = el('button', cls, label);
      b.onclick = () => { closeSheet(); openConnect(panel); };
      body.append(b);
    };
    act('Watch on YouTube',    'primary', 'youtube');
    act('Our Facebook pages',  'ghost',   'facebook');
    act('Email the ministry',  'ghost',   'email');
  });
}

function openConnect(panel){
  go('connect');
  showConnectPanel(panel || 'youtube');
}

const connectLoaded = {};
function showConnectPanel(which){
  $$('#connect-scope button').forEach(b =>
    b.classList.toggle('on', b.dataset.panel === which));
  ['youtube','facebook','email'].forEach(p => {
    const n = $('#connect-' + p);
    if (n) n.hidden = p !== which;
  });
  if (connectLoaded[which]) return;
  connectLoaded[which] = true;
  const box = $('#connect-' + which);
  if (!box) return;
  if (which === 'youtube')  fillYouTube(box);
  if (which === 'facebook') fillFacebook(box);
  if (which === 'email')    fillEmail(box);
}

function embedFrame(src, title){
  const f = el('iframe','embed');
  f.src = src;
  f.title = title;
  f.loading = 'lazy';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.setAttribute('allowfullscreen','');
  f.setAttribute('allow','encrypted-media; picture-in-picture; web-share');
  return f;
}

/* An anchor rather than a button: an installed home-screen app will not open a
   window for a script, but it will always follow a link. */
function outLink(url, label, cls){
  const a = el('a', cls || 'go', label);
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.Browser) a.onclick = e => { e.preventDefault(); openLink(url); };
  return a;
}

function fillYouTube(box){
  if (MINISTRY.channelId){
    // the uploads playlist of a channel is its id with UC swapped for UU
    const list = 'UU' + MINISTRY.channelId.slice(2);
    box.append(embedFrame(
      'https://www.youtube-nocookie.com/embed/videoseries?list=' + encodeURIComponent(list),
      'Kingdom Life Ministry on YouTube'));
  } else {
    box.append(el('p','hint',
      'Every Midrash, and the teaching videos, live on the channel.'));
  }
  const row = el('div','connect-tools');
  row.append(outLink(MINISTRY.youtube, 'Open the channel', 'go solid'));
  box.append(row);
  box.append(el('p','hint','Live every Saturday, 6:30 PM CT.'));
}

function fillFacebook(box){
  // Two pages, one panel. Each feed is built the first time it is asked for,
  // so opening Facebook does not pull down both of them.
  const seg   = el('div','seg fb-seg');
  const stage = el('div','fb-stage');
  const built = {};

  const show = name => {
    $$('.fb-seg button', seg).forEach(b => b.classList.toggle('on', b.dataset.page === name));
    $$('.fb-feed', stage).forEach(n => { n.hidden = n.dataset.page !== name; });
    if (built[name]) return;
    built[name] = true;
    const url  = MINISTRY.facebookPages.find(([label]) => label === name)[1];
    const feed = el('div','fb-feed');
    feed.dataset.page = name;
    feed.append(embedFrame(
      'https://www.facebook.com/plugins/page.php?href=' + encodeURIComponent(url) +
      '&tabs=timeline&small_header=false&adapt_container_width=true' +
      '&hide_cover=false&show_facepile=true',
      name + ' on Facebook'));
    const row = el('div','connect-tools');
    row.append(outLink(url, 'Open ' + name + '\u2019s page', 'go solid'));
    feed.append(row);
    stage.append(feed);
  };

  MINISTRY.facebookPages.forEach(([label], i) => {
    const b = el('button', i === 0 ? 'on' : null, label);
    b.dataset.page = label;
    b.onclick = () => show(label);
    seg.append(b);
  });

  box.append(seg, stage);
  show(MINISTRY.facebookPages[0][0]);
  box.append(el('p','hint',
    'The feeds above are Facebook\u2019s own panel, so they keep their styling.'));
}

function fillEmail(box){
  box.append(el('p','hint','Write to us any time. We read everything that comes in.'));
  const addr = el('p','connect-addr', MINISTRY.email);
  box.append(addr);
  const row = el('div','connect-tools');
  const copy = el('button','go solid','Copy address');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(MINISTRY.email); toast('Address copied'); }
    catch(e){ toast('Could not copy \u2014 long press the address instead'); }
  };
  row.append(copy, outLink('mailto:' + MINISTRY.email, 'Open mail app'));
  box.append(row);
}

/* ── support ──────────────────────────────────────────────────────────── */
function supportSheet(){
  sheet('Support our ministry', body => {
    body.append(el('p','hint',
      'Everything given goes to outreach, the homeless care bags, and missions. ' +
      'No pressure at all. Prayer means just as much, and costs nothing.'));
    MINISTRY.support.forEach(([label, url]) => body.append(outLink(url, label, 'ghost')));
  });
}

/* ── the reader ───────────────────────────────────────────────────────── */
async function openTopic(id, opts={}){
  const t = State.topics.find(x => x.id === id);
  if (!t){ toast('That study is not in this build'); return; }

  State.topic = t; State.mode = 'topic'; State.tblocks = [];
  hideVerseBar();

  const box = $('#topic-body');
  box.innerHTML = '';
  box.append(el('p','kicker','Topic Study'));
  box.append(el('h2','chapter', t.title));
  if (t.subtitle) box.append(el('p','topic-standfirst', t.subtitle));
  box.append(topicTools(t));
  if (t.lede){
    const p = el('p','topic-lede');
    p.innerHTML = refHTML(t.lede);
    box.append(p);
  }

  t.sections.forEach((sec, si) => {
    const s = el('section','topic-part');
    if (sec.kicker)  s.append(el('p','part-kicker', sec.kicker));
    if (sec.heading) s.append(el('h3','part-head', sec.heading));
    sec.blocks.forEach(b => s.append(topicBlock(t, si, b)));
    box.append(s);
  });

  if (t.refIndex && t.refIndex.length) box.append(topicRefIndex(t));
  if (t.note) box.append(el('p','hint', t.note));
  box.append(topicFooter(t));

  LS.set('lastTopic', t.id);
  setHash('topic/' + t.id);
  if (!opts.quiet) go('topic');
}

function topicBlock(t, si, b){
  const i = State.tblocks.length;
  State.tblocks.push({k: b.k, si, block: b});

  let n;
  if (b.t === 'h'){
    n = el('h4','topic-head'); n.innerHTML = refHTML(b.v);
  } else if (b.t === 'q'){
    n = el('div','scripture');
    if (b.ref) n.append(refLine(b.ref));
    const p = el('p'); p.innerHTML = refHTML(b.v); n.append(p);
  } else if (b.t === 'c'){
    n = el('div','callout');
    if (b.title) n.append(el('p','callout-head', b.title));
    const p = el('p'); p.innerHTML = refHTML(b.v); n.append(p);
    if (b.ref) n.append(refLine(b.ref));
  } else if (b.t === 'l'){
    n = el('div','topic-points');
    const ul = el('ul');
    (b.items || []).forEach(x => { const li = el('li'); li.innerHTML = refHTML(x); ul.append(li); });
    n.append(ul);
    if (b.ref) n.append(refLine(b.ref));
  } else if (b.t === 'tbl'){
    n = el('div','tblwrap');
    const tb = el('table','tbl');
    (b.rows || []).forEach(r => {
      const tr = el('tr');
      const a = el('td'); a.innerHTML = refHTML(r.topic);
      const c = el('td'); c.innerHTML = refHTML(r.v);
      tr.append(a, c); tb.append(tr);
    });
    n.append(tb);
  } else {
    n = el('p', b.strong ? 'topic-lead' : null);
    n.innerHTML = refHTML(b.v);
  }

  n.classList.add('unit');
  n.dataset.i = i;
  const hl = State.marks.highlights[vkey(topicBookId(t.id), 0, b.k)];
  if (hl) n.dataset.hl = hl;
  if (State.marks.bookmarks.some(x => x.book === topicBookId(t.id) && x.verse === b.k))
    n.append(el('span','bm','❏'));

  // A reference inside a paragraph opens the passage; the paragraph around it
  // is still selectable, so the tap has to be told apart from the tap.
  n.onclick = e => { if (e.target.closest('a')) return; selectUnit(i, n); };
  return n;
}

function refLine(ref){
  const p = el('p','sref');
  p.append(refAnchor(ref));
  return p;
}

function topicRefIndex(t){
  const s = el('section','topic-part');
  s.append(el('p','part-kicker','Appendix'));
  s.append(el('h3','part-head','Every passage in this study'));
  const tb = el('table','tbl');
  t.refIndex.forEach(row => {
    const tr = el('tr');
    tr.append(el('td', null, row.topic));
    const td = el('td');
    let book = '';
    row.refs.forEach(ref => {
      // "Acts 13:14; 16:13" - the second one is still Acts, and a reader
      // tapping it should not be sent somewhere else.
      const m = ref.match(/^(.+?)\s+\d/);
      if (m) book = m[1];
      td.append(refAnchor(/^\d/.test(ref) && book ? `${book} ${ref}` : ref, ref));
    });
    tr.append(td); tb.append(tr);
  });
  const wrap = el('div','tblwrap'); wrap.append(tb); s.append(wrap);
  return s;
}

/* The PDF button is an anchor wearing a button's clothes. It has to be: an
   installed home-screen app will not open a window for a script, but it will
   always follow a link. */
function pdfLink(t, label){
  const a = el('a','go', label);
  a.href = t.pdfUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.Browser)
    a.onclick = e => { e.preventDefault(); openLink(t.pdfUrl); };
  return a;
}

function topicFooter(t){
  const f = el('div','topic-footer');
  f.append(el('p','hint',
    'This study is also a printable handout. Share it, or open the PDF to print it.'));
  const row = el('div','topic-tools');
  const share = el('button','go solid','Share');
  share.onclick = () => shareSheet(t);
  row.append(share, pdfLink(t, 'Open the PDF'));
  f.append(row);
  return f;
}

function topicTools(t){
  const row = el('div','topic-tools');
  const share = el('button','go solid','Share');
  share.onclick = () => shareSheet(t);
  row.append(share, pdfLink(t, 'Handout PDF'));
  return row;
}

/* ── sharing ──────────────────────────────────────────────────────────────
   Two different things are worth sending: the study itself, which opens in the
   app or in any browser, and the handout, which is the thing you print and put
   in somebody's hand. The sheet offers both rather than guessing. */
function shareSheet(t){
  sheet(t.title, body => {
    body.append(el('p','hint',
      'The link opens this study in the app, or in a browser for anyone who has not installed it.'));

    const act = (label, cls, fn) => { const b = el('button', cls, label); b.onclick = fn; body.append(b); };

    if (canShare()){
      act('Share this study', 'primary', () => nativeShare({
        title: t.title,
        text: [t.title, t.subtitle].filter(Boolean).join(' — '),
        url: topicUrl(t),
      }));
    }
    act('Copy the link', canShare() ? 'ghost' : 'primary',
       () => copyText(topicUrl(t), 'Link copied'));
    const open = pdfLink(t, 'Open the printable PDF');
    open.className = 'ghost';
    open.addEventListener('click', () => closeSheet());
    body.append(open);
    act('Copy the PDF link', 'ghost', () => copyText(t.pdfUrl, 'PDF link copied'));

    body.append(el('p','sharelink', topicUrl(t)));
  });
}

function canShare(){
  const P = window.Capacitor && window.Capacitor.Plugins;
  return !!((P && P.Share) || navigator.share);
}

async function nativeShare(data){
  const P = window.Capacitor && window.Capacitor.Plugins;
  if (P && P.Share){
    try { await P.Share.share({title:data.title, text:data.text, url:data.url,
                               dialogTitle:'Share this study'}); closeSheet(); return; }
    catch(e){ /* the sheet was dismissed, or the plugin is not there */ }
  }
  if (navigator.share){
    try { await navigator.share(data); closeSheet(); return; }
    catch(e){ if (e && e.name === 'AbortError') return; }
  }
  copyText(data.url, 'Link copied');
}

function copyText(text, ok){
  if (!navigator.clipboard){ toast('Copy the link shown below'); return; }
  navigator.clipboard.writeText(text).then(() => { closeSheet(); toast(ok); },
                                           () => toast('Could not copy'));
}

/* ── scripture references inside the prose ────────────────────────────────
   The handouts cite in full - "Genesis 2:1-3", "1 Corinthians 15:20" - so the
   citations can be found in the text itself rather than tagged at build time.
   That means a reference is live wherever it appears: in a quotation's
   heading, in the middle of a sentence, and in the appendix. */
const BOOK_NAMES = [
  'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth',
  '1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra',
  'Nehemiah','Esther','Job','Psalms','Psalm','Proverbs','Ecclesiastes',
  'Song of Solomon','Song of Songs','Isaiah','Jeremiah','Lamentations','Ezekiel',
  'Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk',
  'Zephaniah','Haggai','Zechariah','Malachi',
  'Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians',
  'Galatians','Ephesians','Philippians','Colossians','1 Thessalonians',
  '2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James',
  '1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation',
];
const REF_RX = new RegExp(
  '\\b(' + BOOK_NAMES.slice().sort((a,b)=>b.length-a.length)
                     .map(n => n.replace(/ /g,'\\s+')).join('|') + ')' +
  '\\s+(\\d{1,3})(?::(\\d{1,3}(?:\\s*[-–]\\s*\\d{1,3})?' +
  '(?:\\s*,\\s*\\d{1,3}(?:\\s*[-–]\\s*\\d{1,3})?)*))?', 'g');

/** Escaped HTML with every scripture citation turned into a tappable link. */
function refHTML(s){
  return esc(s).replace(REF_RX, m => `<a href="#" class="reflink inline" data-ref="${m}">${m}</a>`);
}

/** A standalone reference, shown as `label` and opening `ref`. */
function refAnchor(ref, label){
  const a = el('a','reflink', label || ref);
  a.href = '#';
  a.dataset.ref = ref;
  return a;
}

/** Which installed book, if any, holds this passage. */
async function packForBook(name){
  const want = String(name || '').trim().toLowerCase();
  const entry = libraryEntries().find(p => String(p.title||'').toLowerCase() === want);
  if (!entry || !State.installed.includes(entry.id)) return null;
  return await loadPack(entry.id);
}

function verseNums(spec){
  const out = [];
  String(spec || '').split(',').forEach(part => {
    const m = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m){ for (let v = +m[1]; v <= +m[2] && out.length < 40; v++) out.push(v); }
    else if (/^\d+$/.test(part.trim())) out.push(+part.trim());
  });
  return out;
}

/* A reference opens here whether or not the book behind it is installed. If it
   is, the passage is read out of the reader's own copy and they can jump
   straight to it; if it is not, they are told so plainly and handed the
   passage on the web instead. */
async function showPassage(ref){
  const m = String(ref).match(/^(.+?)\s+(\d{1,3})(?::(.+))?$/);
  const pack = m ? await packForBook(m[1]) : null;
  const chNum = m ? +m[2] : 0;
  const nums = m ? verseNums(m[3]) : [];
  const ch = pack ? pack.chapters.find(c => c.num === chNum) : null;

  let text = '';
  if (ch){
    const want = nums.length ? nums : [];
    if (want.length){
      text = want.map(v => ch.verses[String(v)] ? `${sup(v)} ${ch.verses[String(v)]}` : '')
                 .filter(Boolean).join(' ');
    }
  }

  sheet(ref, body => {
    if (text) body.append(el('p','vtext', text));
    else if (ch) body.append(el('p','vtext', `${pack.title} ${chNum} is installed on this device.`));
    else body.append(el('p','hint', m
      ? `${m[1]} is not one of the books installed on this device, so the passage opens on the web.`
      : 'That reference could not be read.'));

    const row = el('div','row');
    if (ch){
      const b = el('button','ghost','Go to the passage');
      b.onclick = () => {
        closeSheet();
        State.mode = 'book';
        openBook(pack.id, true).then(() => openChapter(chNum, nums[0] || null));
      };
      row.append(b);
    }
    const a = link('Open in BibleGateway',
      'https://www.biblegateway.com/passage/?search=' + encodeURIComponent(ref) + '&version=WEB',
      'ghost');
    a.style.textAlign = 'center'; a.style.textDecoration = 'none';
    row.append(a);
    body.append(row);
  });
}

/* ── selecting a paragraph ────────────────────────────────────────────────
   The same bar the reader already knows from the books, doing the same five
   things, on a paragraph instead of a verse. */
function selectUnit(i, node){
  const at = State.selected.indexOf(i);
  if (at >= 0){ State.selected.splice(at, 1); node.classList.remove('sel'); }
  else { State.selected.push(i); State.selected.sort((a,b)=>a-b); node.classList.add('sel'); }
  if (!State.selected.length){ hideVerseBar(); return; }
  showVerseBar();
}

const topicUnit = i => State.tblocks[i];
const topicKey  = i => vkey(topicBookId(State.topic.id), 0, topicUnit(i).k);

function topicSelectionLabel(){
  const t = State.topic, vs = State.selected;
  if (!vs.length) return t.title;
  const sec = t.sections[topicUnit(vs[0]).si] || {};
  const part = sec.heading || sec.kicker || '';
  return part ? `${t.title} · ${part}` : t.title;
}

const topicSelectionText = () =>
  State.selected.map(i => blockText(topicUnit(i).block)).join('\n\n');

function topicAction(act){
  const t = State.topic, vs = State.selected;
  if (!vs.length) return;
  const first = vs[0];
  const ref = topicSelectionLabel();

  if (act === 'bookmark'){
    const key = topicUnit(first).k;
    const at = State.marks.bookmarks.findIndex(
      b => b.book === topicBookId(t.id) && b.verse === key);
    if (at >= 0){ State.marks.bookmarks.splice(at, 1); toast('Bookmark removed'); }
    else {
      State.marks.bookmarks.unshift({book: topicBookId(t.id), bookTitle: t.title,
        chapter: 0, verse: key, ref, note: '', at: Date.now()});
      toast('Bookmarked');
    }
    saveMarks(); reopenTopic(key);
  }
  else if (act === 'note') topicNoteSheet(first, ref);
  else if (act === 'copy'){
    copyText(`${topicSelectionText()}\n\n${t.title} — ${topicUrl(t)}`,
             vs.length > 1 ? `Copied ${vs.length} paragraphs` : 'Copied');
  }
  else if (act === 'words') toast('The concordance works on the scripture in a book');
  else if (act === 'clear'){ setHighlight(null); hideVerseBar(); toast('Cleared'); }
}

function topicNoteSheet(i, ref){
  const t = State.topic, key = topicUnit(i).k;
  const existing = State.marks.bookmarks.find(
    b => b.book === topicBookId(t.id) && b.verse === key);
  sheet(ref, body => {
    const f = el('div','field');
    f.append(el('label', null, 'Your note'));
    const ta = el('textarea');
    ta.value = existing ? existing.note : '';
    ta.placeholder = 'What did you see here?';
    f.append(ta); body.append(f);
    const b = el('button','primary','Save note');
    b.onclick = () => {
      let bm = existing;
      if (!bm){
        bm = {book: topicBookId(t.id), bookTitle: t.title, chapter: 0, verse: key,
              ref, note: '', at: Date.now()};
        State.marks.bookmarks.unshift(bm);
      }
      bm.note = ta.value.trim(); bm.at = Date.now(); bm.ref = ref;
      saveMarks(); closeSheet(); reopenTopic(key); toast('Saved');
    };
    body.append(b);
  });
}

/** Redraw the open study and come back to the paragraph that was being worked
    on, so a bookmark's mark appears without losing the reader's place. */
async function reopenTopic(key){
  const y = window.scrollY;
  await openTopic(State.topic.id, {quiet:true});
  window.scrollTo(0, y);
  if (key) flashBlock(key);
}

function flashBlock(key){
  const i = State.tblocks.findIndex(x => x.k === key);
  if (i < 0) return;
  const n = $(`.unit[data-i="${i}"]`);
  if (!n) return;
  n.classList.add('found');
  setTimeout(() => n.classList.remove('found'), 1400);
}

async function openTopicAt(bookId, key){
  const t = topicOf(bookId);
  if (!t) { toast('That study is not in this build'); return; }
  await openTopic(t.id);
  const i = State.tblocks.findIndex(x => x.k === key);
  if (i >= 0) setTimeout(() => {
    const n = $(`.unit[data-i="${i}"]`);
    if (n) n.scrollIntoView({block:'center'});
    flashBlock(key);
  }, 60);
}

/* ── deep links ───────────────────────────────────────────────────────────
   A shared link is #topic/<id>, which GitHub Pages, the installed web app and
   the APK all hand straight to the page rather than to a server. */
function readHash(){
  const m = String(location.hash || '').match(/^#topic\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}
function setHash(h){
  try { history.replaceState(null, '', '#' + h); } catch(e){ /* file:// and the APK */ }
}
function clearHash(){
  if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch(e){} }
}

/* ── wiring ───────────────────────────────────────────────────────────── */
function bindUI(){
  $('#btn-back').onclick = back;
  $('#btn-refresh').onclick = () => refreshCatalog();
  $('#btn-connect').onclick = connectSheet;
  $('#btn-support').onclick = supportSheet;
  $$('.hub-btn').forEach(b => b.onclick = () => go(b.dataset.hub));
  $$('#connect-scope button').forEach(b =>
    b.onclick = () => showConnectPanel(b.dataset.panel));
  $('#btn-settings').onclick = settingsSheet;
  $('#btn-chapters').onclick = chapterSheet;
  $('#sheet-close').onclick = closeSheet;
  $('#sheet').onclick = e => { if (e.target.id==='sheet') closeSheet(); };
  $('#vb-close').onclick = hideVerseBar;
  $$('#vb-actions button, .vb-actions button').forEach(b => b.onclick = () => verseAction(b.dataset.act));

  $('#prev-ch').onclick = () => { const i=State.book.chapters.findIndex(c=>c.num===State.chapter);
    if (i>0) openChapter(State.book.chapters[i-1].num); };
  $('#next-ch').onclick = () => { const i=State.book.chapters.findIndex(c=>c.num===State.chapter);
    if (i<State.book.chapters.length-1) openChapter(State.book.chapters[i+1].num); };

  // dim the chapter arrows while the page is moving, so they never sit over
  // the words being read, then bring them back as soon as it settles
  let scrollTimer;
  window.addEventListener('scroll', () => {
    document.body.classList.add('scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => document.body.classList.remove('scrolling'), 550);
  }, {passive:true});

  // let the Android back button close what is open before leaving the screen
  const cap = window.Capacitor && window.Capacitor.Plugins;
  if (cap && cap.App){
    cap.App.addListener('backButton', () => {
      if (!$('#sheet').hidden) { closeSheet(); return; }
      if (!$('#verse-bar').hidden) { hideVerseBar(); return; }
      if (['library','search','marks','lex'].includes(State.view)) cap.App.exitApp();
      else back();
    });
  }

  $$('#tabbar button').forEach(b => b.onclick = () => {
    const v = b.dataset.go;
    if (v==='read'){
      if (State.chapter) { go('read', {keepScroll:true}); }
      else if (State.book) go('book');
      else go('library');
      return;
    }
    if (v==='marks') renderMarks();
    if (v==='lex') runLexSearch();
    go(v);
  });

  $('#q').addEventListener('input', debounce(runSearch, 180));
  $('#q-clear').onclick = () => { $('#q').value=''; runSearch(); };
  $$('#search-scope button').forEach(b => b.onclick = () => {
    $$('#search-scope button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); runSearch(); });

  $('#lex-q').addEventListener('input', debounce(runLexSearch, 180));
  $('#lex-clear').onclick = () => { $('#lex-q').value=''; runLexSearch(); };
  $$('#lex-scope button').forEach(b => b.onclick = () => {
    $$('#lex-scope button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); runLexSearch(); });

  // Every scripture citation anywhere in a topic study, in one listener, so a
  // handout with four hundred of them does not carry four hundred handlers.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a.reflink[data-ref]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    showPassage(a.dataset.ref);
  });

  // Someone pasting a shared link into an app that is already open
  window.addEventListener('hashchange', () => {
    const id = readHash();
    if (id && State.topics.some(t => t.id === id)) openTopic(id);
  });

  $$('#marks-tabs button').forEach(b => b.onclick = () => {
    $$('#marks-tabs button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); renderMarks(); });
  $('#export-marks').onclick = exportMarks;
  $('#import-marks').onclick = importMarks;

  document.addEventListener('keydown', e => {
    if (e.key==='Escape'){ closeSheet(); hideVerseBar(); }
    if (State.view==='read' && e.key==='ArrowRight') $('#next-ch').click();
    if (State.view==='read' && e.key==='ArrowLeft')  $('#prev-ch').click();
  });
}

document.addEventListener('DOMContentLoaded', boot);
})();
