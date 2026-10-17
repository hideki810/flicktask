// アプリの外枠だけを保存し、電波がなくても一瞬で開けるようにする。
// HTML は毎回ネットワークを優先（1.5 秒で間に合わなければ保存分）なので、更新が端末に残り続けることはない。
const CACHE = 'flick-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const net = fetch(e.request).then((res) => {
          if (res.ok) cache.put('/', res.clone());
          return res;
        });
        const timeout = new Promise((r) => setTimeout(r, 1500));
        const fast = await Promise.race([net.catch(() => null), timeout]);
        return fast || (await cache.match('/')) || net;
      })()
    );
    return;
  }

  // ファイル名にハッシュが付いた /assets/ は中身が変わらないので保存分を優先
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
  }
});
