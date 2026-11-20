import { translate } from '../../../../i18n/index.js'
import { ApiError } from '../../../api/client.js'

/**
 * WebDAV 的底层请求：PROPFIND 列目录、取版本，GET / PUT / DELETE 读写，MKCOL 建目录。
 * 浏览器直接访问用户的服务器，所以服务器要允许本站的跨域请求（CORS）；请求失败且拿不到状态码时按这个原因提示。
 */

export type WebdavConfig = {
  /** 同步用的文件夹地址，以 / 结尾 */
  url: string
  username: string
  password: string
}

export type DavEntry = {
  /** 相对于文件夹的名字；文件夹自身为空字符串 */
  name: string
  collection: boolean
  /** 文件版本：优先用 ETag，没有时用修改时间和大小 */
  rev: string
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/>' +
  '</d:prop></d:propfind>'

const base64 = (text: string) => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** 文件夹地址统一为 http(s)、去掉查询和片段、以 / 结尾；不合法时抛出给用户看的错误 */
export const normalizeFolderUrl = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(translate('syncWebdavInvalidUrl'))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(translate('syncWebdavInvalidUrl'))
  }
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  return url.href
}

export type DavRequest = {
  depth?: '0' | '1'
  body?: string
  contentType?: string
}

/**
 * 发一个 WebDAV 请求，返回原始响应（不按状态码抛错，由调用方判断）。
 * cache: 'no-store'：同一个文件会被其他设备改写，浏览器缓存的旧内容会让同步读到过期数据。
 */
export const davFetch = async (
  config: WebdavConfig,
  method: string,
  name: string,
  { depth, body, contentType }: DavRequest = {}
): Promise<Response> => {
  const headers: Record<string, string> = {
    Authorization: `Basic ${base64(`${config.username}:${config.password}`)}`,
  }
  if (depth !== undefined) {
    headers.Depth = depth
  }
  if (contentType) {
    headers['Content-Type'] = contentType
  }
  try {
    return await fetch(config.url + encodeURIComponent(name), {
      method,
      headers,
      body,
      cache: 'no-store',
    })
  } catch {
    // 拿不到响应：地址不对、服务器不可达，或者服务器没有允许跨域请求
    throw new ApiError('network', translate('syncWebdavUnreachable'))
  }
}

/** 非预期的状态码：带上方法和状态，便于用户对照服务器日志 */
export const davError = (method: string, response: Response) =>
  new ApiError(
    'http',
    `WebDAV ${method} ${response.status} ${response.statusText}`,
    response.status
  )

const childText = (parent: Element, name: string) =>
  parent.getElementsByTagNameNS('DAV:', name)[0]?.textContent?.trim() || undefined

/** 解析 PROPFIND 的 207 Multi-Status 响应；只采用状态为 2xx 的 propstat */
export const parseMultistatus = (xml: string, folderUrl: string): DavEntry[] => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new ApiError('protocol', 'Invalid WebDAV response')
  }
  const folderPath = decodeURIComponent(new URL(folderUrl).pathname)
  const entries: DavEntry[] = []
  for (const response of doc.getElementsByTagNameNS('DAV:', 'response')) {
    const href = childText(response, 'href')
    if (!href) {
      continue
    }
    const path = decodeURIComponent(new URL(href, folderUrl).pathname)
    const relative = path.startsWith(folderPath) ? path.slice(folderPath.length) : path
    const name = relative.replace(/\/$/, '')
    let etag: string | undefined
    let modified: string | undefined
    let length: string | undefined
    let collection = false
    for (const propstat of response.getElementsByTagNameNS('DAV:', 'propstat')) {
      if (!/\s2\d\d(\s|$)/.test(childText(propstat, 'status') ?? '')) {
        continue
      }
      etag ??= childText(propstat, 'getetag')
      modified ??= childText(propstat, 'getlastmodified')
      length ??= childText(propstat, 'getcontentlength')
      collection ||= propstat.getElementsByTagNameNS('DAV:', 'collection').length > 0
    }
    entries.push({ name, collection, rev: etag ?? `${modified ?? ''}|${length ?? ''}` })
  }
  return entries
}

/** 列出文件夹（Depth: 1）或查看单个文件（Depth: 0）；不存在返回 null */
export const propfind = async (
  config: WebdavConfig,
  name: string,
  depth: '0' | '1'
): Promise<{ response: Response; entries: DavEntry[] | null }> => {
  const response = await davFetch(config, 'PROPFIND', name, {
    depth,
    body: PROPFIND_BODY,
    contentType: 'application/xml; charset=utf-8',
  })
  if (response.status === 404) {
    return { response, entries: null }
  }
  if (response.status !== 207) {
    return { response, entries: [] }
  }
  return { response, entries: parseMultistatus(await response.text(), config.url) }
}
