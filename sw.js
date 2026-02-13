// Bump dit nummer bij elke release
const CACHE_VERSION = "v4";
const STATIC_CACHE = `recepten-db-static-${CACHE_VERSION}`;

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./sw.js"
];

// Install: pre-cache de basisbestanden
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: verwijder oude caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("recepten-db-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Helpers
function isHTMLRequest(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const fresh = await fetch(request);
    // Cache alleen succesvolle responses
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  // Geef eerst cache terug als die er is, update op achtergrond
  return cached || (await fetchPromise) || fetch(request);
}

// Fetch strategy:
// - Navigatie/HTML: network-first (altijd nieuwste index.html)
// - Static assets (js/css/images/fonts): stale-while-revalidate
// - Andere requests: pass-through
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Alleen eigen origin cachen (GitHub Pages assets)
  if (!isSameOrigin(url)) return;

  // Voor navigaties + HTML: netwerk eerst
  if (req.mode === "navigate" || isHTMLRequest(req)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Voor static assets: snel uit cache, maar vernieuw op achtergrond
  if (["script", "style", "image", "font"].includes(req.destination)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Default: probeer cache, anders netwerk
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
