import { SyncAuthError, type SyncBackend } from './backend.js'
import type { SyncCollection } from './collection.js'
import { planSync, type SyncAction } from './plan.js'

/**
 * 同步引擎：对每个数据种类列出本地与远端，规划并执行这一轮的上传、下载、合并和删除。
 * 只依赖 SyncBackend 和 SyncCollection 两个接口，不认识任何具体的服务商或数据。
 *
 * 远端每个条目一个文件 `<种类>-<key>.json`，内容是信封 { v, modifiedAt, data }；
 * 每个种类另有一个 `<种类>.tombstones.json` 记录已删除的 key，其他设备据此在本地删除。
 */

const ENVELOPE_VERSION = 1
/** 删除记录保留的时间：超过后不再保留，长期离线的设备上那条数据会被重新上传 */
export const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000
const CONCURRENCY = 4

type Envelope = { v: number; modifiedAt: number; data: unknown }
type Tombstones = Record<string, number>

export type SyncResult = {
  uploaded: number
  downloaded: number
  merged: number
  deleted: number
  /** 这一轮没处理、留到下一轮的条目数 */
  deferred: number
  /** 处理失败的条目数；error 是其中第一个错误 */
  failed: number
  error?: unknown
}

export const fileName = (collectionId: string, key: string) => `${collectionId}-${key}.json`
export const tombstoneFileName = (collectionId: string) => `${collectionId}.tombstones.json`

const parseEnvelope = (text: string): Envelope | null => {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const { v, modifiedAt, data } = value as Partial<Envelope>
    // 版本比本机新的文件不读也不覆盖，等本机升级
    return typeof v === 'number' && v <= ENVELOPE_VERSION && typeof modifiedAt === 'number'
      ? { v, modifiedAt, data }
      : null
  } catch {
    return null
  }
}

const parseTombstones = (text: string): Tombstones => {
  try {
    const value = JSON.parse(text) as { deleted?: unknown } | null
    const deleted = value?.deleted
    if (typeof deleted !== 'object' || deleted === null) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(deleted).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    )
  } catch {
    return {}
  }
}

const runPool = async <T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>) => {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

class BadRemoteData extends Error {
  constructor(name: string) {
    super(`Unreadable sync file: ${name}`)
    this.name = 'BadRemoteData'
  }
}

const syncCollection = async (
  backend: SyncBackend,
  collection: SyncCollection,
  remoteNames: ReadonlyMap<string, string>,
  result: SyncResult,
  now: () => number
) => {
  const prefix = `${collection.id}-`
  const suffix = '.json'
  const remote = new Map<string, string>()
  for (const [name, rev] of remoteNames) {
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
      remote.set(name.slice(prefix.length, -suffix.length), rev)
    }
  }
  const tombstoneName = tombstoneFileName(collection.id)
  const tombstones = remoteNames.has(tombstoneName)
    ? parseTombstones(await backend.read(tombstoneName))
    : {}
  const actions = planSync(await collection.listLocal(), remote, tombstones)

  const added: Tombstones = {}
  const cleared = new Set<string>()
  const expiry = now() - TOMBSTONE_TTL

  const readRemote = async (key: string) => {
    const name = fileName(collection.id, key)
    const envelope = parseEnvelope(await backend.read(name))
    const data = envelope ? collection.parse(envelope.data) : null
    if (!envelope || data === null) {
      throw new BadRemoteData(name)
    }
    return { modifiedAt: envelope.modifiedAt, data }
  }

  /** 上传；远端在规划之后已经变了就放弃，下一轮会当作冲突重新合并 */
  const upload = async (
    key: string,
    data: unknown,
    modifiedAt: number,
    expectRev: string | undefined
  ) => {
    const name = fileName(collection.id, key)
    if (expectRev !== undefined && (await backend.stat(name))?.rev !== expectRev) {
      return null
    }
    const envelope: Envelope = { v: ENVELOPE_VERSION, modifiedAt, data }
    return backend.write(name, JSON.stringify(envelope))
  }

  /**
   * 删除远端文件并把这条记入待写的删除记录。本地的删除标记不在这里清：
   * 删除记录要到本轮末尾才写入，写入可能失败；等之后某一轮在远端的删除记录里读到这条再清（见 plan.ts 的 forget）。
   */
  const removeRemote = async (action: Extract<SyncAction, { remoteRev: string }>) => {
    const name = fileName(collection.id, action.key)
    await backend.remove(name)
    added[action.key] = action.local?.deletedAt ?? now()
    result.deleted += 1
  }

  const execute = async (action: SyncAction) => {
    const { key } = action
    switch (action.type) {
      case 'upload': {
        const data = await collection.read(key)
        if (data === null) {
          result.deferred += 1
          return
        }
        const entry = await upload(key, data, action.local.modifiedAt, action.remoteRev)
        if (!entry) {
          result.deferred += 1
          return
        }
        await collection.markSynced(key, entry.rev, action.local.modifiedAt)
        if (action.clearTombstone) {
          cleared.add(key)
        }
        result.uploaded += 1
        return
      }
      case 'download': {
        const remoteEntry = await readRemote(key)
        const applied = await collection.write(key, remoteEntry.data, {
          expect: action.local?.modifiedAt,
          modifiedAt: remoteEntry.modifiedAt,
          rev: action.remoteRev,
        })
        result[applied === 'applied' ? 'downloaded' : 'deferred'] += 1
        return
      }
      case 'conflict': {
        const [remoteEntry, localData] = await Promise.all([readRemote(key), collection.read(key)])
        if (localData === null) {
          result.deferred += 1
          return
        }
        const merged = collection.merge(localData, remoteEntry.data, {
          localModifiedAt: action.local.modifiedAt,
          remoteModifiedAt: remoteEntry.modifiedAt,
        })
        const mergedText = JSON.stringify(merged)
        if (mergedText === JSON.stringify(remoteEntry.data)) {
          // 合并结果就是远端那份：本地跟上即可，不用上传
          const applied = await collection.write(key, merged, {
            expect: action.local.modifiedAt,
            modifiedAt: remoteEntry.modifiedAt,
            rev: action.remoteRev,
          })
          result[applied === 'applied' ? 'merged' : 'deferred'] += 1
          return
        }
        const modifiedAt = Math.max(now(), action.local.modifiedAt, remoteEntry.modifiedAt) + 1
        let localStamp = action.local.modifiedAt
        if (mergedText !== JSON.stringify(localData)) {
          const applied = await collection.write(key, merged, {
            expect: action.local.modifiedAt,
            modifiedAt,
          })
          if (applied !== 'applied') {
            result.deferred += 1
            return
          }
          localStamp = modifiedAt
        }
        const entry = await upload(key, merged, modifiedAt, action.remoteRev)
        if (!entry) {
          // 本地已是合并结果且仍标记为有改动，下一轮再与远端的新版本合并
          result.deferred += 1
          return
        }
        await collection.markSynced(key, entry.rev, localStamp)
        result.merged += 1
        return
      }
      case 'deleteLocal': {
        const applied = await collection.remove(key, action.local.modifiedAt)
        result[applied === 'applied' ? 'deleted' : 'deferred'] += 1
        return
      }
      case 'deleteRemote': {
        const stat = await backend.stat(fileName(collection.id, key))
        if (stat && stat.rev !== action.remoteRev) {
          result.deferred += 1
          return
        }
        await removeRemote(action)
        return
      }
      case 'deleteConflict': {
        const remoteEntry = await readRemote(key)
        if (remoteEntry.modifiedAt > (action.local.deletedAt ?? 0)) {
          // 删除之后另一台设备又继续改了：保留，恢复到本地
          const applied = await collection.write(key, remoteEntry.data, {
            expect: action.local.modifiedAt,
            modifiedAt: remoteEntry.modifiedAt,
            rev: action.remoteRev,
          })
          result[applied === 'applied' ? 'downloaded' : 'deferred'] += 1
        } else {
          await removeRemote(action)
        }
        return
      }
      case 'tombstone': {
        const deletedAt = action.local.deletedAt ?? now()
        if (deletedAt < expiry) {
          // 太久以前的删除不再记录（记录本身也只保留这么久），标记直接清掉
          await collection.forget(key, deletedAt)
        } else {
          added[key] = deletedAt
        }
        return
      }
      case 'forget': {
        await collection.forget(key, action.local.deletedAt ?? now())
        return
      }
    }
  }

  let authError: SyncAuthError | undefined
  await runPool(actions, CONCURRENCY, async (action) => {
    if (authError) {
      return
    }
    try {
      await execute(action)
    } catch (error) {
      if (error instanceof SyncAuthError) {
        authError = error
        return
      }
      result.failed += 1
      result.error ??= error
    }
  })

  // 删除记录是多台设备共用的一个文件：写之前重新读一遍并取并集，尽量不覆盖别人刚加的记录。
  // 远端不支持条件写入，两台设备同时写时仍可能互相覆盖；被盖掉的那条由删除它的设备在下一轮补回（本地标记还在）。
  const stale = Object.values(tombstones).some((at) => at < expiry)
  if (!authError && (Object.keys(added).length > 0 || cleared.size > 0 || stale)) {
    const latest = (await backend.stat(tombstoneName))
      ? parseTombstones(await backend.read(tombstoneName))
      : {}
    const next: Tombstones = {}
    for (const [key, at] of [...Object.entries(latest), ...Object.entries(added)]) {
      if (at >= expiry && !cleared.has(key)) {
        next[key] = Math.max(at, next[key] ?? 0)
      }
    }
    await backend.write(tombstoneName, JSON.stringify({ v: ENVELOPE_VERSION, deleted: next }))
  }
  if (authError) {
    throw authError
  }
}

/**
 * 执行一轮同步。单个条目失败不影响其他条目（计入 failed）；
 * 授权失效（SyncAuthError）和列目录失败会直接抛出。
 */
export const runSync = async (
  backend: SyncBackend,
  collections: readonly SyncCollection[],
  now: () => number = Date.now
): Promise<SyncResult> => {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    deleted: 0,
    deferred: 0,
    failed: 0,
  }
  const remoteNames = new Map((await backend.list()).map((entry) => [entry.name, entry.rev]))
  for (const collection of collections) {
    if (!collection.ready()) {
      result.deferred += 1
      continue
    }
    try {
      await syncCollection(backend, collection, remoteNames, result, now)
    } catch (error) {
      if (error instanceof SyncAuthError) {
        throw error
      }
      result.failed += 1
      result.error ??= error
    }
  }
  return result
}
