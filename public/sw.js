importScripts("./firebase-sw-config.js");
importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js");

let messaging = null;
try {
  firebase.initializeApp(self.FIREBASE_CONFIG);
  messaging = firebase.messaging();
} catch (error) {
  messaging = null;
}
const SHELL_CACHE_PREFIX = "soundcheck-shell-";
const SHELL_CACHE = "soundcheck-shell-v21";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=20260806.6",
  "./rock-theme.css?v=20260806.6",
  "./app.js?v=20260806.6",
  "./firebase-config.js",
  "./firebase-sw-config.js",
  "./manifest.webmanifest?v=20260806.6",
  "./icons/soundcheck-32.png",
  "./icons/soundcheck-180.png",
  "./icons/soundcheck-192.png",
  "./icons/soundcheck-512.png",
];

function freshShellRequests() {
  return APP_SHELL.map((path) => new Request(new URL(path, self.location.href).href, { cache: "reload" }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(freshShellRequests()))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const previousShellExists = keys.some((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE);
    await Promise.all(keys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
    if (!previousShellExists) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.allSettled(windows.map((client) => client.navigate(client.url)));
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const isNavigation = event.request.mode === "navigate";
  const requiresFreshCopy = isNavigation || ["script", "style", "manifest"].includes(event.request.destination);
  event.respondWith((async () => {
    try {
      const request = requiresFreshCopy ? new Request(event.request, { cache: "no-store" }) : event.request;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(isNavigation ? "./index.html" : event.request, response.clone());
      }
      return response;
    } catch (error) {
      if (isNavigation) return (await caches.match("./index.html")) || Response.error();
      return (await caches.match(event.request)) || Response.error();
    }
  })());
});

if (messaging) messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  return self.registration.showNotification(data.title || "Soundcheck 예약 알림", {
    body: data.body || "합주실 예약을 확인해 주세요.",
    icon: "./icons/soundcheck-192.png",
    badge: "./icons/soundcheck-32.png",
    tag: `${data.kind || "reservation"}-${data.reservationId || "notice"}`,
    data: { url: data.url || "./#schedule" },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./#schedule", self.location.href).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus().then((client) => client.navigate(targetUrl));
    return self.clients.openWindow(targetUrl);
  }));
});
