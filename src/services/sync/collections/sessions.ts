import * as db from '../../chat/db.js'
import {
  applySyncedSession,
  isSessionBusy,
  removeSyncedSession,
  useChatStore,
} from '../../chat/store.js'
import type { Session } from '../../chat/types.js'
import type { LocalEntry, SyncCollection } from '../collection.js'
import { mergeSessions } from './sessionMerge.js'

/**
 * 会话：每个会话一个远端文件，内容是完整的 Session（含全部分支）。
 * 临时对话不同步；附件原件不同步，其他设备上只有附件的名字。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseSession = (data: unknown): Session | null => {
  if (
    !isRecord(data) ||
    typeof data.id !== 'string' ||
    typeof data.title !== 'string' ||
    typeof data.createdAt !== 'number' ||
    typeof data.updatedAt !== 'number' ||
    !Array.isArray(data.messages) ||
    data.temporary === true
  ) {
    return null
  }
  const valid = data.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      typeof message.createdAt === 'number' &&
      ((message.role === 'user' &&
        typeof message.content === 'string' &&
        Array.isArray(message.files)) ||
        (message.role === 'assistant' && Array.isArray(message.blocks)))
  )
  return valid ? (data as Session) : null
}

export const sessionsCollection: SyncCollection<Session> = {
  id: 'sessions',

  ready: () => {
    const { ready, importingHistory } = useChatStore.getState()
    return ready && !importingHistory
  },

  async listLocal() {
    const [summaries, metas] = await Promise.all([
      db.loadSessionSummaries(),
      db.loadSyncMeta(db.SESSION_SYNC_PREFIX),
    ])
    const metaById = new Map(
      metas.map((meta) => [meta.key.slice(db.SESSION_SYNC_PREFIX.length), meta])
    )
    const entries: LocalEntry[] = []
    for (const summary of summaries) {
      if (summary.temporary) {
        continue
      }
      const meta = metaById.get(summary.id)
      metaById.delete(summary.id)
      entries.push({
        key: summary.id,
        // 加入同步之前就有的会话还没有元数据，按「有改动」处理
        modifiedAt: meta?.modifiedAt ?? summary.updatedAt,
        syncedAt: meta?.syncedAt,
        syncedRev: meta?.syncedRev,
      })
    }
    for (const [id, meta] of metaById) {
      if (meta.deletedAt !== undefined) {
        entries.push({
          key: id,
          modifiedAt: meta.modifiedAt,
          syncedAt: meta.syncedAt,
          syncedRev: meta.syncedRev,
          deletedAt: meta.deletedAt,
        })
      }
    }
    return entries
  },

  async read(key) {
    if (isSessionBusy(key)) {
      return null
    }
    const session = await db.loadSession(key)
    return session && !session.temporary ? session : null
  },

  parse: parseSession,

  async write(key, session, sync) {
    return session.id === key && (await applySyncedSession(session, sync)) ? 'applied' : 'deferred'
  },

  async remove(key, expect) {
    return (await removeSyncedSession(key, expect)) ? 'applied' : 'deferred'
  },

  merge: mergeSessions,

  markSynced: (key, rev, modifiedAt) =>
    db.markSynced(db.SESSION_SYNC_PREFIX + key, rev, modifiedAt),

  forget: (key, deletedAt) => db.dropSyncTombstone(db.SESSION_SYNC_PREFIX + key, deletedAt),

  resetBaselines: () => db.resetSyncBaselines(db.SESSION_SYNC_PREFIX),
}
