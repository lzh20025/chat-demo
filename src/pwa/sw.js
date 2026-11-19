/**
 * Service Worker：离线外壳。只缓存本站的静态文件，安装到主屏幕后断网也能打开应用、查看本地对话。
 * 不处理跨域请求（模型服务、Google 登录与云端硬盘），也不缓存任何接口响应。
 * 下面两个大写占位符在构建时替换，见 rspack.config.ts；产物变了缓存版本就变，激活时清掉旧缓存。
 */
const CACHE_PREFIX = 'chat-demo-'
const CACHE = CACHE_PREFIX + __CACHE_VERSION__
/** 首屏需要的文件：页面、入口脚本和样式、manifest；其余文件在第一次用到时缓存 */
const PRECACHE = __PRECACHE__

const scope = new URL(self.registration.scope)

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

/** 同源的成功响应才写入缓存 */
const store = async (request, response) => {
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname)
  ) {
    return
  }

  if (request.mode === 'navigate') {
    // 页面联网优先：部署后立刻用上新版本；断网时用上次打开的副本，没有就用应用首页
    event.respondWith(
      fetch(request)
        .then((response) => store(request, response))
        .catch(async () => {
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ??
            (await caches.match(scope.href))
          return cached ?? Response.error()
        })
    )
    return
  }

  if (url.pathname.startsWith(`${scope.pathname}static/`)) {
    // 文件名带内容哈希，内容不会变：缓存优先
    event.respondWith(
      caches
        .match(request)
        .then((cached) => cached ?? fetch(request).then((response) => store(request, response)))
    )
    return
  }

  // 图标、manifest、隐私政策等：先用缓存，同时在后台更新
  const network = fetch(request).then((response) => store(request, response))
  event.waitUntil(network.catch(() => undefined))
  event.respondWith(caches.match(request).then((cached) => cached ?? network))
})
