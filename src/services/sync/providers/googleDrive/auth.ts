import { translate } from '../../../../i18n/index.js'
import { ApiError, request } from '../../../api/client.js'
import type { SyncAccount, SyncAuth, SyncAuthState } from '../../auth.js'

/**
 * Google 账号授权：用 Google Identity Services 的令牌模式，全程在浏览器里完成，不需要后端，也没有 client secret。
 * 只申请 drive.appdata：应用只能读写自己在云端硬盘里的隐藏数据目录，看不到用户的其他文件。
 *
 * 这种模式拿不到 refresh token，访问令牌约一小时过期，续期要打开 Google 的授权窗口；
 * 浏览器只允许在用户点击时打开窗口，后台同步里打开一定会被拦截。所以：
 * - 后台不打开窗口：令牌没了或快过期时，等用户下一次点击页面（输入框除外）时顺势续期。
 *   已经授权过、浏览器里 Google 也还登录着时，窗口会自己关掉，用户不需要做任何选择。
 * - 续期成功后通知同步立刻补上一轮；用着的时候在过期前就续上，不会断。
 * - 续期没成功（用户关掉了窗口、需要重新登录 Google）且手上已经没有可用令牌时进入 expired：
 *   同步暂停，界面提示用户点一次「继续同步」。
 * 令牌只放在内存和 sessionStorage，不进 localStorage，也不参与同步。
 */

/** 构建期注入的 OAuth Client ID，见 rspack.config.ts；为空表示没有配置 */
const CLIENT_ID = __GOOGLE_CLIENT_ID__
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const GIS_URL = 'https://accounts.google.com/gsi/client'
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)'
const TOKEN_KEY = 'chat-demo:sync-google-token'
const ACCOUNT_KEY = 'chat-demo:sync-google-account'
/** 提前这么久把令牌当作过期，避免请求发到一半失效 */
const EXPIRY_MARGIN = 60_000
/** 令牌剩余不到这么久时，借用户的下一次点击提前续期 */
const RENEW_AHEAD = 10 * 60_000
/** 提前续期没成功、手上的令牌还能用时，这么久之内不再借点击重试，免得每次点击都弹窗 */
const RETRY_DELAY = 2 * 60_000
/** 点在这些元素上是要输入：此时弹窗会抢走焦点，留到下一次点击 */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

type TokenResponse = {
  access_token?: string
  expires_in?: number | string
  /** 用户实际同意的权限，空格分隔；授权页上可以取消勾选 */
  scope?: string
  error?: string
}
type TokenClient = {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void
}
type GoogleOAuth = {
  initTokenClient(config: {
    client_id: string
    scope: string
    prompt?: string
    login_hint?: string
    callback: (response: TokenResponse) => void
    error_callback?: (error: { type?: string; message?: string }) => void
  }): TokenClient
  revoke(token: string, done?: () => void): void
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth } }
  }
}

type Token = { value: string; expiresAt: number }

const readJson = <T>(storage: () => Storage, key: string): T | null => {
  try {
    return JSON.parse(storage().getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

const writeJson = (storage: () => Storage, key: string, value: unknown) => {
  try {
    if (value === null) {
      storage().removeItem(key)
    } else {
      storage().setItem(key, JSON.stringify(value))
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

let token = readJson<Token>(() => sessionStorage, TOKEN_KEY)
let account = readJson<SyncAccount>(() => localStorage, ACCOUNT_KEY)
/** 续期没成功且没有可用令牌：同步暂停，直到用户点「继续同步」或「重新连接」 */
let paused = false
/** 提前续期失败后，到这个时间之前不再借点击重试 */
let retryAt = 0
/** 正在进行的续期；后台同步拿令牌时等它 */
let renewing: Promise<string | null> | null = null
/** 加载好的 Google Identity Services；点击时要同步打开窗口，必须事先加载好 */
let oauth: GoogleOAuth | null = null
const listeners = new Set<() => void>()

const tokenValid = () => token !== null && token.expiresAt - EXPIRY_MARGIN > Date.now()
const tokenFresh = () => token !== null && token.expiresAt - RENEW_AHEAD > Date.now()

const computeState = (): SyncAuthState => {
  if (!CLIENT_ID) {
    return { status: 'unconfigured' }
  }
  if (!account) {
    return { status: 'signedOut' }
  }
  // 令牌过期但还没试过续期时仍算已连接：下一次点击会续期
  return { status: paused ? 'expired' : 'signedIn', account }
}

let state = computeState()

const notify = () => {
  for (const listener of listeners) {
    listener()
  }
}

const update = () => {
  const next = computeState()
  if (next.status !== state.status || next.account?.id !== state.account?.id) {
    state = next
    notify()
  }
}

const setToken = (next: Token | null) => {
  token = next
  writeJson(() => sessionStorage, TOKEN_KEY, next)
}

const setAccount = (next: SyncAccount | null) => {
  account = next
  writeJson(() => localStorage, ACCOUNT_KEY, next)
}

let gisLoading: Promise<GoogleOAuth> | null = null

/** 需要登录或续期时才加载 Google 的脚本；没配置 Client ID 或没连接过时不会请求 */
const loadGis = (): Promise<GoogleOAuth> =>
  (gisLoading ??= new Promise<GoogleOAuth>((resolve, reject) => {
    const ready = () => {
      const loaded = window.google?.accounts?.oauth2
      if (loaded) {
        oauth = loaded
        resolve(loaded)
      } else {
        reject(new Error('Google Identity Services failed to initialize'))
      }
    }
    if (window.google?.accounts?.oauth2) {
      ready()
      return
    }
    const script = document.createElement('script')
    script.src = GIS_URL
    script.async = true
    script.onload = ready
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.append(script)
  }).catch((error: unknown) => {
    gisLoading = null
    throw error
  }))

const preloadGis = () => {
  void loadGis().catch(() => undefined)
}

/**
 * 打开 Google 的授权窗口取令牌。必须在用户点击的处理函数里同步调用：浏览器只允许这时打开窗口。
 * prompt 为空字符串时只在需要时显示同意页：已经授权过的账号窗口会自己关掉。
 */
const requestToken = (client: GoogleOAuth, prompt?: string): Promise<Token> =>
  new Promise<Token>((resolve, reject) => {
    const tokenClient = client.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      ...(prompt === undefined ? {} : { prompt }),
      ...(account ? { login_hint: account.label } : {}),
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? 'Google authorization failed'))
          return
        }
        // 授权页上没有勾选云端硬盘的权限：令牌能拿到，但之后每个请求都会被拒
        if (response.scope !== undefined && !response.scope.split(' ').includes(SCOPE)) {
          reject(new Error(translate('syncErrorScopeDenied')))
          return
        }
        resolve({
          value: response.access_token,
          expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
        })
      },
      error_callback: (error) =>
        reject(new Error(error.message ?? error.type ?? 'Google authorization was cancelled')),
    })
    tokenClient.requestAccessToken()
  })

/** 借这次点击续期；成功后通知同步补上一轮 */
const renew = (client: GoogleOAuth) => {
  const connected = account
  renewing = requestToken(client, '')
    .then((next) => {
      if (account !== connected) {
        // 续期期间断开或换了账号，这个令牌作废
        return null
      }
      setToken(next)
      retryAt = 0
      notify()
      return next.value
    })
    .catch(() => {
      if (tokenValid()) {
        // 提前续期没成功，手上的令牌还能用一阵：先用着，过一会儿再借点击试
        retryAt = Date.now() + RETRY_DELAY
        return token?.value ?? null
      }
      setToken(null)
      paused = true
      update()
      return null
    })
    .finally(() => {
      renewing = null
    })
}

/** 页面上的点击（捕获阶段，先于按钮自己的处理）：令牌没了或快过期时顺势续期 */
const renewOnClick = (event: MouseEvent) => {
  if (!account || paused || renewing || tokenFresh() || Date.now() < retryAt) {
    return
  }
  if (event.target instanceof Element && event.target.closest(EDITABLE)) {
    return
  }
  if (!oauth) {
    // 脚本还没加载好：这次先加载，下一次点击再续期
    preloadGis()
    return
  }
  renew(oauth)
}

if (CLIENT_ID && typeof window !== 'undefined') {
  window.addEventListener('click', renewOnClick, true)
  if (account) {
    // 连接过的设备随时可能需要续期，提前加载脚本，点击时才能立刻打开窗口
    preloadGis()
  }
}

const fetchAccount = async (accessToken: string): Promise<SyncAccount> => {
  let response: Response
  try {
    response = await request(ABOUT_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      // 登录成功但 Drive 拒绝：最常见的是 Cloud 项目里没有启用 Drive API，其次是没给权限
      throw new Error(
        translate(
          /has not been used|is disabled|accessNotConfigured/i.test(error.message)
            ? 'syncErrorApiDisabled'
            : 'syncErrorForbidden',
          { message: error.message }
        )
      )
    }
    throw error
  }
  const { user } = (await response.json()) as {
    user?: { emailAddress?: string; permissionId?: string }
  }
  const label = user?.emailAddress ?? ''
  return { id: user?.permissionId ?? label, label }
}

export const googleAuth: SyncAuth = {
  getState: () => state,

  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  prepare() {
    if (CLIENT_ID) {
      preloadGis()
    }
  },

  async connect() {
    if (!CLIENT_ID) {
      throw new Error('Google OAuth client ID is not configured')
    }
    // 脚本已加载时同步打开窗口；重新连接同一个账号时不再让用户选账号、确认授权
    const client = oauth ?? (await loadGis())
    const next = await requestToken(client, account ? '' : undefined)
    // 先确认拿到的是哪个账号，再认为连接成功
    const nextAccount = await fetchAccount(next.value)
    setToken(next)
    setAccount(nextAccount)
    paused = false
    retryAt = 0
    update()
    // 状态没变（如已连接时重新连接）也要通知同步立刻补上一轮
    notify()
  },

  async disconnect() {
    const current = token
    setToken(null)
    setAccount(null)
    paused = false
    retryAt = 0
    update()
    if (current) {
      try {
        const client = oauth ?? (await loadGis())
        client.revoke(current.value)
      } catch {
        // 撤销失败不影响本机断开；令牌一小时内自行失效
      }
    }
  },

  async getToken({ refresh = false } = {}) {
    if (!CLIENT_ID || !account || paused) {
      return null
    }
    if (renewing) {
      return renewing
    }
    if (refresh) {
      // 服务器拒绝了手上的令牌
      setToken(null)
    } else if (tokenValid()) {
      return token?.value ?? null
    }
    // 后台打开授权窗口会被浏览器拦截：等用户下一次点击时续期，续期成功后会通知同步
    preloadGis()
    return null
  },
}
