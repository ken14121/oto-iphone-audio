const CACHE_NAME = "oto-shell-v13";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/editor.js",
  "/editor-worker.js",
  "/lame.min.js",
  "/manifest.webmanifest",
  "/icon.svg",
];
// サーバー（Renderの無料プラン）が休止中だと応答まで1分ほどかかるため、それ以上は待たずに保存済みの画面を使う
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      APP_SHELL.map((url) => fetch(url, { cache: "reload" }).then((response) => cache.put(url, response)))
    ))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// 画面のファイルはHTMLもJS/CSSも同じ方針（ネット優先・つながらなければ保存済み）で返す。
// HTMLを保存済みから出した画面では、JS/CSSも保存済みを使って食い違いを防ぎ、待ち時間も1回分で済ませる。
const cacheOnlyClients = new Set();

async function networkFirst(url, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  // 画面遷移(navigate)のRequestはそのまま再利用できないので、URLで取り直す
  const network = fetch(url, { cache: "no-store" }).then((response) => {
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  const fromNetwork = await Promise.race([network.catch(() => null), timeout]);
  if (fromNetwork && fromNetwork.ok) return { response: fromNetwork, cached: false };
  const cached = await cache.match(cacheKey);
  if (cached) return { response: cached, cached: true };
  return { response: fromNetwork || await network, cached: false };
}

async function handleNavigate(event, url) {
  const { response, cached } = await networkFirst(url, "/index.html");
  if (cached && event.resultingClientId) cacheOnlyClients.add(event.resultingClientId);
  return response;
}

async function handleAsset(event, url, cacheKey) {
  if (cacheOnlyClients.has(event.clientId)) {
    const cached = await caches.match(cacheKey);
    if (cached) return cached;
  }
  return (await networkFirst(url, cacheKey)).response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/files/")) return;
  if (request.mode === "navigate") event.respondWith(handleNavigate(event, url.href));
  else event.respondWith(handleAsset(event, url.href, url.pathname));
});
