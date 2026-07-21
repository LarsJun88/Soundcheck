const SHELL_CACHE = "soundcheck-shell-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./rock-theme.css",
  "./app.js?v=20260721.6",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/soundcheck.svg",
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