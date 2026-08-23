const CACHE = 'family-s-v3';
const STATIC = ['./','./index.html','./styles.css','./app.js','./pilot-controls.js','./shared/chat.js','./shared/pilot.js','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('family-s-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request.mode === 'navigate' ? './index.html' : request, response.clone());
    }
    return response;
  } catch {
    if (request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
    return (await caches.match(request)) || Response.error();
  }
}
