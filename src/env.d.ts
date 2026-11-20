declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Google OAuth Client ID（Web 应用类型），见 rspack.config.ts；为空表示未配置云端同步 */
declare const __GOOGLE_CLIENT_ID__: string

/** Dropbox App key（Scoped access、App folder 类型），见 rspack.config.ts；为空表示未配置 Dropbox 同步 */
declare const __DROPBOX_APP_KEY__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
