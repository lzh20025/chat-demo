import { ApiError } from '../../../api/client.js'
import { SyncAuthError, type RemoteEntry, type SyncBackend } from '../../backend.js'
import { markWebdavExpired, webdavConfig } from './auth.js'
import { davError, davFetch, propfind, type WebdavConfig } from './dav.js'

/**
 * WebDAV 后端：同步文件平铺在用户指定的文件夹里，版本用 ETag。
 * 文件夹里的其他文件不影响同步（引擎只认自己的文件名前缀），但建议给本应用单独建一个文件夹。
 */

const current = (): WebdavConfig => {
  const config = webdavConfig()
  if (!config) {
    throw new SyncAuthError()
  }
  return config
}

/** 服务器拒绝凭据时暂停同步，由界面提示重新填写 */
const checkAuth = (response: Response) => {
  if (response.status === 401 || response.status === 403) {
    markWebdavExpired()
    throw new SyncAuthError()
  }
}

export const createWebdavBackend = (): SyncBackend => ({
  async list() {
    const { response, entries } = await propfind(current(), '', '1')
    checkAuth(response)
    if (response.status !== 207 || entries === null) {
      throw davError('PROPFIND', response)
    }
    return entries
      .filter((entry) => entry.name && !entry.collection && !entry.name.includes('/'))
      .map(({ name, rev }) => ({ name, rev }))
  },

  async read(name) {
    const response = await davFetch(current(), 'GET', name)
    checkAuth(response)
    if (!response.ok) {
      throw davError('GET', response)
    }
    return response.text()
  },

  async stat(name) {
    const { response, entries } = await propfind(current(), name, '0')
    checkAuth(response)
    if (entries === null) {
      return null
    }
    if (response.status !== 207) {
      throw davError('PROPFIND', response)
    }
    const entry = entries.find((item) => !item.collection)
    return entry ? { name, rev: entry.rev } : null
  },

  async write(name, text): Promise<RemoteEntry> {
    const config = current()
    const response = await davFetch(config, 'PUT', name, {
      body: text,
      contentType: 'application/json; charset=utf-8',
    })
    checkAuth(response)
    if (!response.ok) {
      throw davError('PUT', response)
    }
    // 用这次写入返回的 ETag 作为版本；拿不到（服务器没暴露 ETag 头）时再查一次
    const etag = response.headers.get('ETag')
    if (etag) {
      return { name, rev: etag }
    }
    const { entries } = await propfind(config, name, '0')
    const entry = entries?.find((item) => !item.collection)
    if (!entry) {
      throw new ApiError('protocol', `WebDAV PUT ${name}: file missing after upload`)
    }
    return { name, rev: entry.rev }
  },

  async remove(name) {
    const response = await davFetch(current(), 'DELETE', name)
    checkAuth(response)
    if (!response.ok && response.status !== 404) {
      throw davError('DELETE', response)
    }
  },
})
