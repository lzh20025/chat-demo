import { translate } from '../../../../i18n/index.js'
import type { SyncAccount, SyncAuth, SyncAuthState } from '../../auth.js'
import { davError, davFetch, normalizeFolderUrl, propfind, type WebdavConfig } from './dav.js'

/**
 * WebDAV 授权：用户自己的服务器（Nextcloud、ownCloud、群晖、坚果云或自建的 Apache / nginx 等）上的一个文件夹。
 * 用户名 + 密码以 HTTP Basic 方式访问，建议使用服务器生成的应用专用密码；凭据不会过期，也不需要后端。
 * 地址、用户名、密码只存在本机 localStorage（和 API Key 一样），不参与同步。
 * 服务器拒绝（401 / 403，如密码改了、应用密码被撤销）时进入 expired，同步暂停，等用户在设置里重新填写。
 */

const STORAGE_KEY = 'chat-demo:sync-webdav'

const readConfig = (): WebdavConfig | null => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WebdavConfig | null
    return value?.url && value.username ? value : null
  } catch {
    return null
  }
}

const writeConfig = (value: WebdavConfig | null) => {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

let config = readConfig()
let expired = false
const listeners = new Set<() => void>()

const accountOf = (value: WebdavConfig): SyncAccount => ({
  // 换了服务器、文件夹或用户都按新账号处理，同步基线作废
  id: `${value.url}\n${value.username}`,
  label: `${value.username} @ ${new URL(value.url).host}`,
})

const computeState = (): SyncAuthState =>
  config
    ? { status: expired ? 'expired' : 'signedIn', account: accountOf(config) }
    : { status: 'signedOut' }

let state = computeState()

const update = () => {
  state = computeState()
  for (const listener of listeners) {
    listener()
  }
}

/** 当前连接的服务器；后端每次请求时读取 */
export const webdavConfig = (): WebdavConfig | null => (expired ? null : config)

/** 服务器拒绝了凭据：暂停同步，等用户重新填写 */
export const markWebdavExpired = () => {
  if (config && !expired) {
    expired = true
    update()
  }
}

/** 确认能用这组凭据访问文件夹；文件夹不存在时创建 */
const checkFolder = async (next: WebdavConfig) => {
  const { response, entries } = await propfind(next, '', '0')
  if (response.status === 401 || response.status === 403) {
    throw new Error(translate('syncWebdavUnauthorized'))
  }
  if (entries === null) {
    const created = await davFetch(next, 'MKCOL', '')
    if (created.status === 401 || created.status === 403) {
      throw new Error(translate('syncWebdavUnauthorized'))
    }
    if (!created.ok) {
      throw davError('MKCOL', created)
    }
    return
  }
  if (response.status !== 207) {
    throw davError('PROPFIND', response)
  }
  if (!entries.some((entry) => entry.name === '' && entry.collection)) {
    throw new Error(translate('syncWebdavNotFolder'))
  }
}

export const webdavAuth: SyncAuth = {
  getState: () => state,

  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  connectDefaults: (): Record<string, string> =>
    config ? { url: config.url, username: config.username } : {},

  async connect(values) {
    const next: WebdavConfig = {
      url: normalizeFolderUrl(values?.url ?? ''),
      username: values?.username ?? '',
      password: values?.password ?? '',
    }
    await checkFolder(next)
    config = next
    expired = false
    writeConfig(next)
    update()
  },

  async disconnect() {
    config = null
    expired = false
    writeConfig(null)
    update()
  },

  async getToken() {
    return config && !expired ? config.password : null
  },
}
