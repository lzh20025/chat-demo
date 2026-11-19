import { ApiError, request } from '../../../api/client.js'
import type { SyncAuth } from '../../auth.js'
import { SyncAuthError, type RemoteEntry, type SyncBackend } from '../../backend.js'

/**
 * Google Drive 后端：文件放在应用专属的 appDataFolder 里（用户在云端硬盘界面看不到，卸载授权时可一并删除）。
 * 文件版本用 Drive 给出的 md5Checksum。Drive 按 id 而不是按名字定位文件，这里维护名字到 id 的对应。
 */

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const FIELDS = 'id,name,md5Checksum'

type DriveFile = { id: string; name: string; md5Checksum?: string }

const toEntry = (file: DriveFile): RemoteEntry => ({
  name: file.name,
  // 极少数情况下 Drive 不返回校验和，用 id 兜底：版本对不上只会多同步一次
  rev: file.md5Checksum ?? file.id,
})

export const createDriveBackend = (auth: SyncAuth): SyncBackend => {
  const ids = new Map<string, string>()

  /** 带上访问令牌请求；令牌被拒时续期后重试一次，仍不行就报授权失效 */
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const send = async (refresh: boolean) => {
      const token = await auth.getToken({ refresh })
      if (!token) {
        throw new SyncAuthError()
      }
      return request(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
      })
    }
    try {
      return await send(false)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error
      }
    }
    try {
      return await send(true)
    } catch (error) {
      throw error instanceof ApiError && error.status === 401 ? new SyncAuthError() : error
    }
  }

  const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404

  /** 同名文件的 id；本地没记录时到远端查一次（另一台设备刚创建的文件） */
  const findId = async (name: string): Promise<string | undefined> => {
    const known = ids.get(name)
    if (known) {
      return known
    }
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`,
      orderBy: 'createdTime',
      fields: `files(${FIELDS})`,
      pageSize: '1',
    })
    const { files = [] } = (await (await call(`${FILES_URL}?${query}`)).json()) as {
      files?: DriveFile[]
    }
    if (files[0]) {
      ids.set(name, files[0].id)
    }
    return files[0]?.id
  }

  return {
    async list() {
      const entries = new Map<string, DriveFile>()
      let pageToken: string | undefined
      do {
        const query = new URLSearchParams({
          spaces: 'appDataFolder',
          q: 'trashed = false',
          // 两台设备同时首次同步时可能各建一个同名文件：统一认最早创建的那个，多出来的不读也不删。
          // 写了多余文件的设备会发现远端版本对不上，把自己的内容合并进被认的那个。
          orderBy: 'createdTime',
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: '1000',
          ...(pageToken ? { pageToken } : {}),
        })
        const page = (await (await call(`${FILES_URL}?${query}`)).json()) as {
          nextPageToken?: string
          files?: DriveFile[]
        }
        for (const file of page.files ?? []) {
          if (!entries.has(file.name)) {
            entries.set(file.name, file)
          }
        }
        pageToken = page.nextPageToken
      } while (pageToken)

      ids.clear()
      for (const file of entries.values()) {
        ids.set(file.name, file.id)
      }
      return [...entries.values()].map(toEntry)
    },

    async read(name) {
      const id = await findId(name)
      if (!id) {
        throw new ApiError('http', `Sync file not found: ${name}`, 404)
      }
      return (await call(`${FILES_URL}/${id}?alt=media`)).text()
    },

    async stat(name) {
      const id = await findId(name)
      if (!id) {
        return null
      }
      try {
        const response = await call(`${FILES_URL}/${id}?fields=${FIELDS},trashed`)
        const file = (await response.json()) as DriveFile & { trashed?: boolean }
        return file.trashed ? null : toEntry(file)
      } catch (error) {
        if (isNotFound(error)) {
          ids.delete(name)
          return null
        }
        throw error
      }
    },

    async write(name, text) {
      const upload = async (id: string | undefined) => {
        const boundary = `sync-${Math.random().toString(36).slice(2)}`
        const metadata = id ? {} : { name, parents: ['appDataFolder'] }
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          JSON.stringify(metadata),
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          text,
          `--${boundary}--`,
          '',
        ].join('\r\n')
        const response = await call(
          `${UPLOAD_URL}${id ? `/${id}` : ''}?uploadType=multipart&fields=${FIELDS}`,
          {
            method: id ? 'PATCH' : 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body,
          }
        )
        return (await response.json()) as DriveFile
      }
      const id = await findId(name)
      let file: DriveFile
      try {
        file = await upload(id)
      } catch (error) {
        if (!id || !isNotFound(error)) {
          throw error
        }
        // 记下的文件已被其他设备删除：重新创建
        ids.delete(name)
        file = await upload(undefined)
      }
      ids.set(name, file.id)
      return toEntry({ ...file, name })
    },

    async remove(name) {
      const id = await findId(name)
      if (!id) {
        return
      }
      try {
        await call(`${FILES_URL}/${id}`, { method: 'DELETE' })
      } catch (error) {
        if (!isNotFound(error)) {
          throw error
        }
      }
      ids.delete(name)
    },
  }
}
