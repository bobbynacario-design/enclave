// Enclave Service Worker

const CACHE_NAME = 'enclave-shell-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './style.css',
  './manifest.json',
  './app.js',
  './firebase.js',
  './icon-192.png',
  './icon-512.png',
  './src/state.js',
  './src/util/escape.js',
  './src/util/constants.js',
  './src/util/circles.js',
  './src/util/time.js',
  './src/util/log.js',
  './src/util/shell-bridge.js',
  './src/ui/toast.js',
  './src/ui/modals.js',
  './src/ui/drivePicker.js',
  './src/auth/auth.js',
  './src/shell/routing.js',
  './src/shell/shell.js',
  './src/pages/feed.js',
  './src/pages/members.js',
  './src/pages/events.js',
  './src/pages/messages.js',
  './src/pages/projects.js',
  './src/pages/notifications.js',
  './src/pages/resources.js',
  './src/pages/briefings.js',
  './src/pages/admin.js'
];

// External origins that must never be intercepted
const BYPASS_ORIGINS = [
  'https://www.gstatic.com',
  'https://apis.google.com',
  'https://accounts.google.com',
  'https://firestore.googleapis.com',
  'https://firebasestorage.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://www.googleapis.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
];

function shouldBypass(url) {
  return BYPASS_ORIGINS.some(origin => url.startsWith(origin));
}

// ─── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    }).catch(err => {
      console.error('[SW] Pre-cache failed:', err);
    })
  );
});

// ─── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Pass external Firebase/Google requests straight to network
  if (shouldBypass(url)) return;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const isNavigation = request.mode === 'navigate';

  if (isNavigation) {
    // Network-first for HTML navigation requests
    event.respondWith(
      fetch(request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }).catch(() => {
        return caches.match('./offline.html');
      })
    );
  } else {
    // Cache-first for static assets
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        });
      })
    );
  }
});
