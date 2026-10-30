const AUDIO_CACHE_NAME = 'lw-offline-original-audio-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isAudioRequest(url, request) {
  if (url.pathname.startsWith('/api/')) return false;
  if (request.destination === 'audio') return true;
  if (
    url.hostname === 'ssl.gstatic.com' ||
    url.hostname === 'upload.wikimedia.org'
  ) {
    return true;
  }
  if (/\.(mp3|ogg|wav|m4a)(\?.*)?$/i.test(url.pathname)) {
    return true;
  }
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isAudioRequest(url, request)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const cached =
          (await cache.match(request, { ignoreVary: true, ignoreSearch: false })) ||
          (await cache.match(request.url, { ignoreVary: true }));
        if (cached) {
          return cached;
        }
        return fetch(request);
      })()
    );
  }
});
