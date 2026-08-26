/* Kingdom Life Study — web edition.

   Everything in this file exists only because the app is now also a website.
   app.js is untouched and knows nothing about any of it: it already ran in a
   plain browser, it just had no way to be kept offline or added to a phone's
   home screen. That is what this adds.

   Three jobs:
     1. register the service worker, which is what makes the site work with no
        signal at all — the same promise the Android app makes;
     2. offer the home-screen install, which on Android is a button and on an
        iPhone can only ever be an instruction, because Safari refuses to give
        a page any programmatic way to ask;
     3. tell the reader, rather than surprise them, when a new build is live. */
(() => {
'use strict';

const $  = s => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

const LS = {
  get(k, d){ try { const v = localStorage.getItem('kls.web.'+k); return v==null?d:JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem('kls.web.'+k, JSON.stringify(v)); } catch(e){} }
};

const cards = () => $('#web-cards');

/* A card in the Library, in the same clothes as the app-update card that was
   already there. Returns the node so the caller can fill it. */
function card(id){
  const host = cards();
  if (!host) return null;
  let c = host.querySelector('#'+id);
  if (c) { c.innerHTML = ''; return c; }
  c = el('div', 'update-card');
  c.id = id;
  host.append(c);
  return c;
}

function dropCard(id){
  const c = cards() && cards().querySelector('#'+id);
  if (c) c.remove();
}

/* ── is it already installed? ──────────────────────────────────────────────
   Two different answers on two different platforms, and both have to be asked:
   iOS has never implemented display-mode and Android has never implemented
   navigator.standalone. */
const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ reports itself as a Mac; the touch points give it away
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* Safari is the only iOS browser that can add to the home screen. Chrome and
   Firefox on an iPhone are Safari underneath but do not expose Add to Home
   Screen, so telling their users to look for it would send them hunting for a
   menu item that is not there. */
const isIOSSafari = () => isIOS() && !/crios|fxios|edgios|opios/i.test(navigator.userAgent);

/* ── the service worker ───────────────────────────────────────────────────── */
let waitingWorker = null;

function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', {scope: './'}).then(reg => {

    // Already one waiting from a previous visit
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // "installed" with a controller already present means this is a new
        // build arriving over an older one, not the very first visit.
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });

    // Check once an hour in a session left open for a long time
    setInterval(() => reg.update().catch(()=>{}), 3600000);
  }).catch(e => console.warn('offline support unavailable', e));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/* Never swap the app out from under someone mid-chapter. The new build sits
   and waits until they say so. */
function offerUpdate(sw){
  waitingWorker = sw;
  const c = card('web-update');
  if (!c) return;
  c.append(el('h4', null, 'A new version is ready'));
  c.append(el('p', null, 'Reload to get the latest books and fixes. Your highlights, bookmarks and downloaded books are kept.'));
  const b = el('button', 'go solid', 'Reload');
  b.onclick = () => {
    b.disabled = true; b.textContent = 'Reloading…';
    waitingWorker.postMessage({type: 'SKIP_WAITING'});
  };
  c.append(b);
}

/* ── add to home screen ───────────────────────────────────────────────────── */
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();           // keep Chrome's own bar out of the way
  deferredPrompt = e;
  if (!installed() && !LS.get('installHidden', false)) offerInstall();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  LS.set('installHidden', true);
  dropCard('web-install');
});

function offerInstall(){
  const c = card('web-install');
  if (!c) return;
  c.append(el('h4', null, 'Add to your home screen'));
  c.append(el('p', null,
    'Install Kingdom Life Study and it opens like any other app, full screen, and reads with no signal.'));
  const b = el('button', 'go solid', 'Install');
  b.onclick = async () => {
    if (!deferredPrompt) return;
    b.disabled = true;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch(e){}
    deferredPrompt = null;
    dropCard('web-install');
  };
  const later = el('button', 'go', 'Not now');
  later.style.marginLeft = '8px';
  later.onclick = () => { LS.set('installHidden', true); dropCard('web-install'); };
  c.append(b); c.append(later);
}

/* The iPhone version. Safari gives a page no way to trigger this, so all that
   can be done is say plainly where the button is — most people have never
   noticed it. */
function offerIOSInstall(){
  const c = card('web-install');
  if (!c) return;
  c.append(el('h4', null, 'Add to your iPhone'));
  const p = el('p', null, '');
  p.innerHTML = 'Tap <strong>Share</strong> at the bottom of Safari, scroll down, ' +
                'and tap <strong>Add to Home Screen</strong>. It then opens full screen ' +
                'like any other app and reads with no signal.';
  c.append(p);
  const later = el('button', 'go', 'Got it');
  later.onclick = () => { LS.set('installHidden', true); dropCard('web-install'); };
  c.append(later);
}

/* ── start ────────────────────────────────────────────────────────────────── */
function start(){
  registerSW();
  if (isIOSSafari() && !installed() && !LS.get('installHidden', false)){
    // wait for the boot screen to clear so the card is not announced to an
    // empty library
    setTimeout(offerIOSInstall, 1200);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

})();
