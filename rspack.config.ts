import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Compiler, type Configuration } from '@rspack/core'

/**
 * 本机的构建变量放在不进仓库的 .env.local 里（每行 NAME=value，见 .env.example）；
 * 已经在环境里设置的变量优先，CI 上直接用环境变量。
 */
const envFile = new URL('./.env.local', import.meta.url)
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) {
      process.env[match[1]] ??= match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

/**
 * 生成 sw.js（源码见 src/pwa/sw.js）：填入缓存版本和首屏预缓存列表。
 * 版本取全部产物文件名（含内容哈希）的摘要，任何文件变了就换新缓存。
 */
const serviceWorkerPlugin = {
  apply(compiler: Compiler) {
    compiler.hooks.thisCompilation.tap('ServiceWorker', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'ServiceWorker', stage: rspack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE },
        () => {
          const assets = compilation
            .getAssets()
            .map((asset) => asset.name)
            .sort()
          const cacheVersion = createHash('sha256')
            .update(`${version}\n${assets.join('\n')}`)
            .digest('hex')
            .slice(0, 12)
          const entryFiles = [...(compilation.entrypoints.get('main')?.getFiles() ?? [])]
          const precache = ['./', ...entryFiles, 'manifest.webmanifest']
          const template = readFileSync(path.resolve(root, 'src/pwa/sw.js'), 'utf8')
          // 只有清单里的路径会被 Service Worker 处理和缓存，其余同源请求（如同源接口）照常走网络
          const placeholders = {
            __CACHE_VERSION__: cacheVersion,
            __PRECACHE__: precache,
            __APP_FILES__: assets,
          }
          let source = template
          for (const [placeholder, value] of Object.entries(placeholders)) {
            if (source.split(placeholder).length !== 2) {
              throw new Error(`src/pwa/sw.js must contain ${placeholder} exactly once`)
            }
            source = source.replace(placeholder, JSON.stringify(value))
          }
          compilation.emitAsset('sw.js', new rspack.sources.RawSource(source))
        }
      )
    })
  },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** Google OAuth Client ID，注入为 __GOOGLE_CLIENT_ID__；为空时云端同步显示为未配置 */
  googleClientId?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  googleClientId = process.env.GOOGLE_CLIENT_ID ?? '',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        // 隐私政策是独立的静态页，Google OAuth 同意页和设置里的云端同步都链接到它
        { from: path.resolve(root, 'src/privacy.html'), to: 'privacy.html', toType: 'file' },
        // PWA：图标和 manifest，index.html 用相对路径引用
        { from: path.resolve(root, 'src/pwa/icons'), to: 'icons' },
        {
          from: path.resolve(root, 'src/pwa/manifest.webmanifest'),
          to: 'manifest.webmanifest',
          toType: 'file',
        },
      ],
    }),
    serviceWorkerPlugin,
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
