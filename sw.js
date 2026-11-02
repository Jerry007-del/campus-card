/**
 * Service Worker —— 让 App 离线也能打开
 *
 * ★ 重要修复（2026-11-02）：
 *   原来是 cache-first —— 浏览器永远返回缓存里的旧文件，
 *   导致「改了前端但线上没变」，而且用户自己完全察觉不到。
 *   改成 network-first：优先联网，失败才回落缓存。
 *   配合版本化 CACHE 名 + activate 清理旧缓存，发版后自动生效。
 */

const BUILD = "v3";
const CACHE = "hzue-card-" + BUILD;
const ASSETS = ["./", "./index.html", "./app.js", "./manifest.json", "./icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())   // 立刻接管，不等旧 SW 退出
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // 清掉所有非当前版本的缓存（包括旧版本）
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 只处理本站的静态资源；API 与跨域一律走网络
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  // ★ network-first：先联网拿最新的，失败（离线）才用缓存
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(e.request).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
