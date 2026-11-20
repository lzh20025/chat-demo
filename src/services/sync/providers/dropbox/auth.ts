import { ApiError, request } from '../../../api/client.js'
import type { SyncAccount, SyncAuth, SyncAuthState } from '../../auth.js'

/**
 * Dropbox 授权：OAuth 2 授权码 + PKCE，全程在浏览器里完成，不需要后端，也没有 client secret。
 * 申请 token_access_type=offline 拿到 refresh token，之后在后台用它换新的访问令牌（普通的 fetch，不弹窗），
 * 所以连接一次就一直可用，直到用户断开或在 Dropbox 里撤销授权。
 *
 * 连接时整页跳转到 Dropbox 的授权页，授权后回到应用所在的目录，地址里带着 code 和 state；
 * 应用启动时在这里用 code 换令牌，再把这两个参数从地址栏去掉。用跳转而不是弹窗：不依赖用户手势，
 * 手机上「添加到主屏幕」的应用里也能用。
 *
 * refresh token 和账号放在 localStorage（和 API Key 一样只在本机，不参与同步），访问令牌放在 sessionStorage。
 */

/** 构建期注入的 App key，见 rspack.config.ts；为空表示没有配置 */
const APP_KEY = __DROPBOX_APP_KEY__
const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize'
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const ACCOUNT_URL = 'https://api.dropboxapi.com/2/users/get_current_account'
const REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke'
/** 应用在 Dropbox App Console 里也要勾选这些权限 */
const SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
]
const STORED_KEY = 'chat-demo:sync-dropbox'
const TOKEN_KEY = 'chat-demo:sync-dropbox-token'
/** 跳转到授权页前记下的 PKCE verifier、state 和回调地址，回来时核对 */
const PENDING_KEY = 'chat-demo:sync-dropbox-pending'
/** 提前这么久把令牌当作过期，避免请求发到一半失效 */
const EXPIRY_MARGIN = 60_000

type Stored = { refreshToken: string; account: SyncAccount }
type Token = { value: string; expiresAt: number }
type Pending = { verifier: string; state: string; redirectUri: string }
type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string }

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

let stored = readJson<Stored>(() => localStorage, STORED_KEY)
let token = readJson<Token>(() => sessionStorage, TOKEN_KEY)
/** refresh token 被拒（用户在 Dropbox 里撤销了授权）：同步暂停，等用户重新连接 */
let expired = false
/** 上一次连接失败的原因（从授权页回来时出错），展示在设置里 */
let connectError: string | undefined
let refreshing: Promise<string | null> | null = null
const listeners = new Set<() => void>()

const computeState = (): SyncAuthState => {
  if (!APP_KEY) {
    return { status: 'unconfigured' }
  }
  if (!stored) {
    return { status: 'signedOut', error: connectError }
  }
  return { status: expired ? 'expired' : 'signedIn', account: stored.account }
}

let state = computeState()

const update = () => {
  state = computeState()
  for (const listener of listeners) {
    listener()
  }
}

const setToken = (next: Token | null) => {
  token = next
  writeJson(() => sessionStorage, TOKEN_KEY, next)
}

const setStored = (next: Stored | null) => {
  stored = next
  writeJson(() => localStorage, STORED_KEY, next)
}

const tokenValid = () => token !== null && token.expiresAt - EXPIRY_MARGIN > Date.now()

const toToken = (response: TokenResponse): Token => ({
  value: response.access_token,
  expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
})

const base64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const randomString = (bytes: number) => base64Url(crypto.getRandomValues(new Uint8Array(bytes)))

const codeChallenge = async (verifier: string) =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  )

/** 授权后回到的地址：应用所在的目录（去掉 index.html、查询和片段），要在 App Console 里登记 */
const redirectUri = () => new URL('./', window.location.href).href

const tokenRequest = async (params: Record<string, string>): Promise<TokenResponse> => {
  const response = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  return (await response.json()) as TokenResponse
}

const fetchAccount = async (accessToken: string): Promise<SyncAccount> => {
  const response = await request(ACCOUNT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const account = (await response.json()) as {
    account_id?: string
    email?: string
    name?: { display_name?: string }
  }
  const label = account.email ?? account.name?.display_name ?? ''
  return { id: account.account_id ?? label, label }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message || error.name : String(error)

/** 应用启动时：如果是从 Dropbox 授权页回来，用 code 换令牌并完成连接 */
const completeRedirect = async () => {
  const params = new URLSearchParams(window.location.search)
  const returnedState = params.get('state')
  if (!returnedState || (!params.has('code') && !params.has('error'))) {
    return
  }
  const pending = readJson<Pending>(() => sessionStorage, PENDING_KEY)
  if (!pending || pending.state !== returnedState) {
    // 不是这个应用发起的授权（或已经处理过）：不碰地址栏
    return
  }
  writeJson(() => sessionStorage, PENDING_KEY, null)
  // 先把授权参数从地址栏去掉：刷新、分享链接时不会再带上一次性的 code
  const clean = new URL(window.location.href)
  for (const key of ['code', 'state', 'error', 'error_description']) {
    clean.searchParams.delete(key)
  }
  window.history.replaceState(window.history.state, '', clean.href)

  const code = params.get('code')
  if (!code) {
    connectError = params.get('error_description') ?? params.get('error') ?? 'access_denied'
    update()
    return
  }
  try {
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: APP_KEY,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
    })
    if (!response.refresh_token) {
      throw new Error('Dropbox did not return a refresh token')
    }
    const next = toToken(response)
    const account = await fetchAccount(next.value)
    setToken(next)
    setStored({ refreshToken: response.refresh_token, account })
    expired = false
    connectError = undefined
  } catch (error) {
    connectError = errorMessage(error)
  }
  update()
}

if (APP_KEY && typeof window !== 'undefined') {
  void completeRedirect()
}

export const dropboxAuth: SyncAuth = {
  getState: () => state,

  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  async connect() {
    if (!APP_KEY) {
      throw new Error('Dropbox app key is not configured')
    }
    const pending: Pending = {
      verifier: randomString(64),
      state: randomString(16),
      redirectUri: redirectUri(),
    }
    const url = new URL(AUTHORIZE_URL)
    url.search = new URLSearchParams({
      client_id: APP_KEY,
      response_type: 'code',
      redirect_uri: pending.redirectUri,
      state: pending.state,
      code_challenge: await codeChallenge(pending.verifier),
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: SCOPES.join(' '),
    }).toString()
    writeJson(() => sessionStorage, PENDING_KEY, pending)
    connectError = undefined
    window.location.assign(url.href)
    // 页面即将跳转到授权页，这个 Promise 不会结束
    await new Promise<never>(() => {})
  },

  async disconnect() {
    const cached = tokenValid() ? token?.value : undefined
    const refreshToken = stored?.refreshToken
    setToken(null)
    setStored(null)
    expired = false
    connectError = undefined
    update()
    // 在 Dropbox 里撤销授权：撤销访问令牌会连同它的 refresh token 一起作废。
    // 手上没有可用的访问令牌（令牌已过期），或者它已经被 Dropbox 拒绝时，先用 refresh token 换一个再撤销，
    // 否则本机删掉了 refresh token，应用在 Dropbox 里却仍然有授权。撤销失败不影响本机断开。
    const revoke = (accessToken: string) =>
      request(REVOKE_URL, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } })
    void (async () => {
      if (cached) {
        try {
          await revoke(cached)
          return
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) {
            throw error
          }
        }
      }
      if (refreshToken) {
        const response = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: APP_KEY,
        })
        await revoke(response.access_token)
      }
    })().catch(() => undefined)
  },

  async getToken({ refresh = false } = {}) {
    if (!APP_KEY || !stored || expired) {
      return null
    }
    if (!refresh && tokenValid()) {
      return token?.value ?? null
    }
    const refreshToken = stored.refreshToken
    refreshing ??= tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: APP_KEY,
    })
      .then((response) => {
        const next = toToken(response)
        setToken(next)
        return next.value
      })
      .catch((error: unknown) => {
        // refresh token 被拒：用户撤销了授权或删除了应用。网络问题只是这一轮拿不到，不改变状态
        if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
          setToken(null)
          expired = true
          update()
        }
        return null
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  },
}
