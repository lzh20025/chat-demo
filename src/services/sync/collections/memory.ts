import * as db from '../../chat/db.js'
import { applySyncedMemory, readClearedAt, useMemory } from '../../memory/state.js'
import type { SyncCollection } from '../collection.js'
import { mergeMemory, type MemorySyncData } from './memoryMerge.js'

/**
 * 记忆：条目、元数据（不再提及、删除过的内容等）和近期对话摘要合成一个远端文件。
 * 活动记录只留在本机。冲突时按条目合并，见 memoryMerge.ts。
 */

const KEY = 'main'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isTimes = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((at) => typeof at === 'number')

const parseMemory = (data: unknown): MemorySyncData | null => {
  if (
    !isRecord(data) ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.digests) ||
    !isTimes(data.deletedItems) ||
    !isTimes(data.revivedItems) ||
    !isTimes(data.deletedDigests) ||
    typeof data.clearedAt !== 'number' ||
    (data.profile !== null && !isRecord(data.profile))
  ) {
    return null
  }
  const items = data.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.text === 'string' &&
      typeof item.createdAt === 'number' &&
      typeof item.updatedAt === 'number' &&
      Array.isArray(item.sources)
  )
  const digests = data.digests.every(
    (digest) =>
      isRecord(digest) &&
      typeof digest.sessionId === 'string' &&
      typeof digest.summary === 'string' &&
      typeof digest.digestedAt === 'number'
  )
  return items && digests ? (data as MemorySyncData) : null
}

export const memoryCollection: SyncCollection<MemorySyncData> = {
  id: 'memory',

  ready: () => useMemory.getState().ready,

  async listLocal() {
    const { modifiedAt, meta } = await db.loadMemoryForSync()
    // 本机从没有过记忆时不列出：远端有就直接下载，不当作冲突
    return modifiedAt === undefined
      ? []
      : [{ key: KEY, modifiedAt, syncedAt: meta?.syncedAt, syncedRev: meta?.syncedRev }]
  },

  async read() {
    const { state } = await db.loadMemoryForSync()
    return { ...state, clearedAt: readClearedAt() }
  },

  parse: parseMemory,

  async write(_key, data, sync) {
    const { clearedAt, ...state } = data
    return (await applySyncedMemory(state, clearedAt, sync)) ? 'applied' : 'deferred'
  },

  // 记忆是单个条目，不会被整体删除
  remove: async () => 'deferred',

  merge: mergeMemory,

  markSynced: (_key, rev, modifiedAt) => db.markSynced(db.MEMORY_SYNC_KEY, rev, modifiedAt),

  forget: async () => {},

  resetBaselines: () => db.resetSyncBaselines(db.MEMORY_SYNC_KEY),
}
