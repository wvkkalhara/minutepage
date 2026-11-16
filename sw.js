/* MinutePage service worker
   Strategy: Stale-While-Revalidate for same-origin files and the static CDN assets
   (fonts are bypassed; styles and icons are now inline), so repeat visits are instant while a fresh copy is fetched in the background.
   Firebase / Google endpoints are NEVER intercepted: they always go straight to the network.
   To ship an update that every visitor gets immediately, bump VERSION. */

const VERSION = "minutepage-v6.2.0";
const CORE = ["./", "./index.html", "./manifest.json", "./404.html", "./assets/brand/logo.svg", "./assets/brand/favicon-48.png"];

// Hosts that must bypass the cache entirely (realtime data, auth, analytics, SDK modules, fonts).
const BYPASS_HOSTS = [
  "firebaseio.com",
  "googleapis.com",
  "gstatic.com",
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // allSettled: one missing optional file must not block installation
    await Promise.allSettled(CORE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (res.ok) await cache.put(url, await clean(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (BYPASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h))) return;   // network only
  if (url.origin === self.location.origin && url.pathname.endsWith("/sw.js")) return;           // never cache the worker itself
  event.respondWith(staleWhileRevalidate(event));
});

// A redirected response cannot be served to a navigation request, so rebuild it as a plain one.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const navigation = request.mode === "navigate";
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: navigation });

  const refresh = fetch(request)
    .then(async (res) => {
      // cache only good responses (never a 404 page) and opaque cross-origin script responses
      if (res && (res.status === 200 || res.type === "opaque")) {
        const copy = navigation ? await clean(res.clone()) : res.clone();
        await cache.put(request, copy).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);          // update in the background, answer instantly from cache
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;

  if (navigation) {                    // offline and never visited this URL: show the app shell
    const shell = (await cache.match("./index.html")) || (await cache.match("./"));
    if (shell) return shell;
  }
  return new Response("You appear to be offline.", { status: 503, statusText: "Offline", headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
