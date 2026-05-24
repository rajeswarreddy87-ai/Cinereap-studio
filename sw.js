const CACHE = 'cinereap-v1';
const ASSETS = [
  '/Cinereap-studio/',
  '/Cinereap-studio/index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&family=JetBrains+Mono:wght@400;700&display=swap'
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return Promise.allSettled(ASSETS.map(url => c.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
  // Don't cache API calls
  if (e.request.url.includes('api.anthropic.com') ||
      e.request.url.includes('api.elevenlabs.io') ||
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('accounts.google.com') ||
      e.request.url.includes('localhost')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/Cinereap-studio/'));
    })
  );
});

// Background sync for uploads
self.addEventListener('sync', e => {
  if (e.tag === 'yt-upload') {
    e.waitUntil(doBackgroundUpload());
  }
});

async function doBackgroundUpload() {
  // Triggered when connectivity restored
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_UPLOAD' }));
}

// Push notifications
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'CineRecap Studio', {
      body: data.body || 'Your video is ready!',
      icon: '/Cinereap-studio/icon.png',
      badge: '/Cinereap-studio/icon.png',
      vibrate: [200, 100, 200],
      data: data
    })
  );
});
