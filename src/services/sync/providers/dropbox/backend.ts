import { ApiError, request } from '../../../api/client.js'
import type { SyncAuth } from '../../auth.js'
import { SyncAuthError, type RemoteEntry, type SyncBackend } from '../../backend.js'

/**
 * Dropbox 后端：应用申请的是「App folder」权限，只能读写 Dropbox 里 Apps/<应用名> 这一个文件夹，
 * 看不到用户的其他文件。路径 "" 是这个文件夹的根，文件平铺在根下；版本用 Dropbox 给出的 rev。
 */

const API_URL = 'https://api.dropboxapi.com/2/'
const CONTENT_URL = 'https://content.dropboxapi.com/2/'

type DropboxFile = { '.tag': string; name: string; rev?: string }
type ListResult = { entries: DropboxFile[]; cursor: string; has_more: boolean }

/** Dropbox-API-Arg 头只能放 ASCII：非 ASCII 字符写成 \uXXXX */
const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

const pathOf = (name: string) => `/${name}`

/** 文件不存在：Dropbox 返回 409，错误摘要里带 not_found */
const isNotFound = (error: unknown) =>
  error instanceof ApiError && error.status === 409 && /not_found/.test(error.message)

export const createDropboxBackend = (auth: SyncAuth): SyncBackend => {
  /** 带上访问令牌请求；令牌被拒时续期后重试一次，仍不行就报授权失效 */
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    const send = async (refresh: boolean) => {
      const accessToken = await auth.getToken({ refresh })
      if (!accessToken) {
        throw new SyncAuthError()
      }
      return request(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          Authorization: `Bearer ${accessToken}`,
        },
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

  const rpc = async <T>(endpoint: string, arg: unknown): Promise<T> =>
    (await (
      await call(API_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arg),
      })
    ).json()) as T

  const toEntry = (file: DropboxFile): RemoteEntry => ({ name: file.name, rev: file.rev ?? '' })

  return {
    async list() {
      let page = await rpc<ListResult>('files/list_folder', { path: '', recursive: false })
      const files = [...page.entries]
      while (page.has_more) {
        page = await rpc<ListResult>('files/list_folder/continue', { cursor: page.cursor })
        files.push(...page.entries)
      }
      return files.filter((file) => file['.tag'] === 'file').map(toEntry)
    },

    async read(name) {
      const response = await call(`${CONTENT_URL}files/download`, {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': headerJson({ path: pathOf(name) }) },
      })
      return response.text()
    },

    async stat(name) {
      try {
        const file = await rpc<DropboxFile>('files/get_metadata', { path: pathOf(name) })
        return file['.tag'] === 'file' ? toEntry(file) : null
      } catch (error) {
        if (isNotFound(error)) {
          return null
        }
        throw error
      }
    },

    async write(name, text) {
      const response = await call(`${CONTENT_URL}files/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerJson({
            path: pathOf(name),
            mode: 'overwrite',
            autorename: false,
            // 不在用户的 Dropbox 里为每次同步发通知
            mute: true,
          }),
        },
        body: text,
      })
      return toEntry({ ...((await response.json()) as DropboxFile), name })
    },

    async remove(name) {
      try {
        await rpc('files/delete_v2', { path: pathOf(name) })
      } catch (error) {
        if (!isNotFound(error)) {
          throw error
        }
      }
    },
  }
}
