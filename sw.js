const CACHE_NAME = 'listplanner-v6';
const ASSETS = ['./index.html', './styles.css', './app.js', './manifest.json', './firebase-config.js', './icon.svg'];

self.addEventListener('install', event => {
  // skipWaiting first so the SW activates immediately
  self.skipWaiting();
  // Cache assets but never let individual failures block installation
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(ASSETS.map(url => cache.add(url)))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Show a system notification when a Web Push arrives
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'ListPlanner', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || 'ListPlanner', {
      body:  data.body  || '',
      icon:  './icon-192.png',
      badge: './icon-192.png',
      data:  { url: data.url || './' },
    })
  );
});

// Open/focus the app when the user taps the notification
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('ListPlanner') && 'focus' in client) return client.focus();
      }
      return clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', event => {
  // Don't intercept Firebase/Google API requests — let them go straight to network
  const url = event.request.url;
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('googleapis.com')
  ) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
