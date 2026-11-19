import { translate } from '../../../../i18n/index.js'
import { ApiError, request } from '../../../api/client.js'
import type { SyncAccount, SyncAuth, SyncAuthState } from '../../auth.js'

/**
 * Google 账号授权：用 Google Identity Services 的令牌模式，全程在浏览器里完成，不需要后端，也没有 client secret。
 * 只申请 drive.appdata：应用只能读写自己在云端硬盘里的隐藏数据目录，看不到用户的其他文件。
 *
 * 这种模式拿不到 refresh token，访问令牌约一小时过期。过期后先尝试静默续期（不弹同意页）；
 * 浏览器拦截了弹窗或需要重新同意时进入 expired，等用户再点一次「重新连接」。
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
/** 静默续期失败后置位，直到用户重新连接 */
let renewalFailed = false
const listeners = new Set<() => void>()

const tokenValid = () => token !== null && token.expiresAt - EXPIRY_MARGIN > Date.now()

const computeState = (): SyncAuthState => {
  if (!CLIENT_ID) {
    return { status: 'unconfigured' }
  }
  if (!account) {
    return { status: 'signedOut' }
  }
  // 令牌过期但还没试过续期时仍算已连接：下一次同步会先静默续期
  return { status: renewalFailed ? 'expired' : 'signedIn', account }
}

let state = computeState()

const update = () => {
  const next = computeState()
  if (next.status !== state.status || next.account?.id !== state.account?.id) {
    state = next
    for (const listener of listeners) {
      listener()
    }
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

/** 第一次需要登录时才加载 Google 的脚本；没配置 Client ID 或没用到同步时不会请求 */
const loadGis = (): Promise<GoogleOAuth> =>
  (gisLoading ??= new Promise<GoogleOAuth>((resolve, reject) => {
    const ready = () => {
      const oauth = window.google?.accounts?.oauth2
      if (oauth) {
        resolve(oauth)
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

/** silent：不弹同意页，只用于续期；浏览器可能因为没有用户操作而拦截弹窗 */
const requestToken = async (silent: boolean): Promise<Token> => {
  const oauth = await loadGis()
  return new Promise<Token>((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      ...(silent ? { prompt: '' } : {}),
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
    client.requestAccessToken()
  })
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

let renewing: Promise<string | null> | null = null

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
      void loadGis().catch(() => undefined)
    }
  },

  async connect() {
    if (!CLIENT_ID) {
      throw new Error('Google OAuth client ID is not configured')
    }
    const next = await requestToken(false)
    // 先确认拿到的是哪个账号，再认为连接成功
    const nextAccount = await fetchAccount(next.value)
    setToken(next)
    setAccount(nextAccount)
    renewalFailed = false
    update()
  },

  async disconnect() {
    const current = token
    setToken(null)
    setAccount(null)
    renewalFailed = false
    update()
    if (current) {
      try {
        const oauth = await loadGis()
        oauth.revoke(current.value)
      } catch {
        // 撤销失败不影响本机断开；令牌一小时内自行失效
      }
    }
  },

  async getToken({ refresh = false } = {}) {
    if (!CLIENT_ID || !account) {
      return null
    }
    if (!refresh && tokenValid()) {
      return token?.value ?? null
    }
    if (renewalFailed) {
      return null
    }
    renewing ??= requestToken(true)
      .then((next) => {
        setToken(next)
        return next.value
      })
      .catch(() => {
        setToken(null)
        renewalFailed = true
        update()
        return null
      })
      .finally(() => {
        renewing = null
      })
    return renewing
  },
}
