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
const SHELL_CACHE = "soundcheck-shell-v14";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./rock-theme.css",
  "./app.js?v=20260728.2",
  "./firebase-config.js",
  "./firebase-sw-config.js",
  "./manifest.webmanifest",
  "./icons/soundcheck-32.png",
  "./icons/soundcheck-180.png",
  "./icons/soundcheck-192.png",
  "./icons/soundcheck-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
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
