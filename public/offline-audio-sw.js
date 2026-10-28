const AUDIO_CACHE_NAME = 'lw-offline-original-audio-v1';
const APP_SHELL_CACHE_NAME = 'lw-app-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isAudioRequest(url, request) {
  if (request.destination === 'audio') return true;
  if (
    url.hostname === 'ssl.gstatic.com' ||
    url.hostname === 'upload.wikimedia.org' ||
    url.hostname === '1200-word-spelling.vercel.app'
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

  // 1. Original Spelling Audio & Pronunciation Files -> Cache-First for 100% Offline Playback
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

        try {
          const networkResponse = await fetch(request);
          if (
            networkResponse &&
            (networkResponse.status === 200 || networkResponse.status === 0)
          ) {
            await cache.put(request.url, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          const fallbackNoCors = await fetch(request.url, {
            mode: 'no-cors',
          }).catch(() => null);
          if (fallbackNoCors) {
            await cache.put(request.url, fallbackNoCors.clone());
            return fallbackNoCors;
          }
          throw err;
        }
      })()
    );
    return;
  }
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'CACHE_AUDIO_URLS' || !Array.isArray(data.urls)) {
    return;
  }

  event.waitUntil(
    (async () => {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      for (const rawUrl of data.urls) {
        if (!rawUrl || typeof rawUrl !== 'string') continue;
        try {
          const existing = await cache.match(rawUrl, { ignoreVary: true });
          if (existing) continue;
          const resp = await fetch(rawUrl, { mode: 'no-cors' });
          if (resp && (resp.status === 200 || resp.status === 0)) {
            await cache.put(rawUrl, resp);
          }
        } catch {
          // Ignore individual offline fetch errors
        }
      }
    })()
  );
});
