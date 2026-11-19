/**
 * 注册 Service Worker（见 src/pwa/sw.js），让应用可以安装到主屏幕、断网时也能打开。
 * 只在生产构建、安全上下文（https 或 localhost）里注册：开发服务器不受缓存干扰，file:// 页面本来就不支持。
 */
export const registerServiceWorker = () => {
  if (
    process.env.NODE_ENV !== 'production' ||
    !window.isSecureContext ||
    !('serviceWorker' in navigator)
  ) {
    return
  }
  window.addEventListener('load', () => {
    // 相对路径：部署在子目录（如 GitHub Pages 的 /<仓库名>/）时作用域就是该目录
    navigator.serviceWorker.register('sw.js').catch(() => {
      // 注册失败只是没有离线能力，不影响使用
    })
  })
}
