// Keep VERSION in step with APP_BUILD in ./src/version.js.
// Settings shows APP_BUILD, so "what is deployed" and "what is running on this
// device" can be told apart at a glance. Editing this file without bumping both
// leaves the old build cached and the fix invisible.
const VERSION = "2026.09.02-swcachefix1";
const SHELL_CACHE = `slate-shell-${VERSION}`;
const FONT_CACHE = `slate-font-${VERSION}`;

// Must be present for the app to run at all. Fetch with cache:"reload" so a
// corrupt HTTP cache cannot repopulate a new shell with mixed module versions.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/app.css",
  "./assets/fonts/lexend-400.woff2",
  "./assets/fonts/lexend-700.woff2",
  "./vendor/rough.esm.js",
  "./vendor/perfect-freehand.mjs",
  "./src/app.js",
  "./src/sw-register.js",
  "./src/version.js",
  "./src/deployment.js",
  "./src/model.js",
  "./src/scene.js",
  "./src/actions.js",
  "./src/history.js",
  "./src/registry.js",
  "./src/geometry.js",
  "./src/ordering.js",
  "./src/migrate.js",
  "./src/render.js",
  "./src/shapes.js",
  "./src/input.js",
  "./src/props.js",
  "./src/store.js",
  "./src/boards.js",
  "./src/backup.js",
  "./src/export.js",
  "./src/settings.js",
  "./src/ui.js",
  "./src/tools/index.js",
  "./src/tools/select.js",
  "./src/tools/hand.js",
  "./src/tools/shape.js",
  "./src/tools/linear.js",
  "./src/tools/freedraw.js",
  "./src/tools/text.js",
  "./src/tools/eraser.js",
  "./src/binding.js",
  "./src/containers.js",
  "./src/arrange.js",
  "./src/snapping.js",
  "./src/clipboard.js",
  "./src/images.js",
  "./src/library.js",
  "./src/search.js",
  "./src/contextmenu.js",
  "./src/tools/image.js",
  "./src/journal.js",
  "./src/journal-record.js",
  "./src/activity-session.js",
  "./src/journal-ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon.svg",
];

// The handwriting font is 60 KB and the app is perfectly usable without it —
// a slow or failed fetch must not block installation.
const OPTIONAL = [
  "./assets/fonts/virgil.woff2",
  "./docs/README-KO.md",
  "./docs/USER-GUIDE-KO.md",
  "./docs/TROUBLESHOOTING-KO.md",
  "../shared/v1/sync.js",
  "../shared/v2/journal.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const shellFiles = await Promise.all(APP_SHELL.map(async (url) => {
      const request = new Request(url, { cache: "reload" });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`Could not cache ${url}: ${response.status}`);
      return [request, response];
    }));
    await Promise.all(shellFiles.map(([request, response]) => shell.put(request, response)));
    const fonts = await caches.open(FONT_CACHE);
    await Promise.all(OPTIONAL.map((url) => fetch(new Request(url, { cache: "reload" }))
      .then((response) => (response.ok ? fonts.put(url, response) : null))
      .catch(() => null)));
    // The shell was cached atomically above, so activate immediately. A broken
    // old module graph cannot post SKIP_WAITING from app code.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("slate-") && key !== SHELL_CACHE && key !== FONT_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // Journal metadata can use GitHub's API after explicit opt-in. Cross-origin
  // requests must bypass the cache so reads cannot be confused with app files.
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function networkFirstNavigation(request) {
  try {
    const response = await withTimeout(fetch(request), 3500);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("./index.html", response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request))
      || (await caches.match("./index.html"))
      || Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Network timeout")), milliseconds)),
  ]);
}
