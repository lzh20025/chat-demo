import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as db from '../../chat/db.js'
import type { Session } from '../../chat/types.js'

/** 同步元数据与数据同事务写入：这里用内存版 IndexedDB 直接验证 chat/db.ts 的改动标记 */

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: null,
  messages: [],
  ...extra,
})

const digest = (sessionId: string): db.MemoryDigest => ({
  sessionId,
  title: sessionId,
  summary: `summary of ${sessionId}`,
  updatedAt: 2,
  digestedAt: 3,
  messageCount: 2,
})

const meta = async (key: string) => db.getSyncMeta(key)

/** 记下一次成功的同步，之后的改动才看得出「又变了」 */
const markMemorySynced = async () => {
  const current = await meta(db.MEMORY_SYNC_KEY)
  if (current) {
    await db.markSynced(db.MEMORY_SYNC_KEY, 'rev', current.modifiedAt)
  }
}

const memoryDirty = async () => {
  const current = await meta(db.MEMORY_SYNC_KEY)
  return current !== undefined && current.modifiedAt !== current.syncedAt
}

describe('sync tracking in chat/db', () => {
  it('marks sessions dirty on save and rename, but not temporary chats', async () => {
    await db.saveSession(session('s1'))
    const saved = await meta('sessions:s1')
    expect(saved?.modifiedAt).toBeGreaterThan(0)
    expect(saved?.deletedAt).toBeUndefined()

    await db.renameSession('s1', 'renamed')
    expect((await meta('sessions:s1'))?.modifiedAt).toBeGreaterThan(saved?.modifiedAt ?? 0)

    await db.saveSession(session('temp', { temporary: true }))
    expect(await meta('sessions:temp')).toBeUndefined()
    await db.deleteSession('temp')
    expect(await meta('sessions:temp')).toBeUndefined()
  })

  it('tombstones the digest and marks memory dirty when a chat with a digest is deleted', async () => {
    await db.saveSession(session('with-digest'))
    await db.saveMemoryDigest(digest('with-digest'))
    await markMemorySynced()
    expect(await memoryDirty()).toBe(false)

    await db.deleteSession('with-digest')

    expect((await meta('sessions:with-digest'))?.deletedAt).toBeDefined()
    expect(await memoryDirty()).toBe(true)
    const { state } = await db.loadMemoryForSync()
    expect(state.digests.map((item) => item.sessionId)).not.toContain('with-digest')
    expect(state.deletedDigests).toHaveProperty('with-digest')
  })

  it('leaves memory untouched when the deleted chat had no digest', async () => {
    await db.saveSession(session('no-digest'))
    await markMemorySynced()
    await db.deleteSession('no-digest')
    expect(await memoryDirty()).toBe(false)
    expect((await db.loadMemoryForSync()).state.deletedDigests).not.toHaveProperty('no-digest')
  })

  it('tombstones every digest when all chats are replaced', async () => {
    await db.saveSession(session('old-1'))
    await db.saveSession(session('old-2'))
    await db.saveMemoryDigest(digest('old-1'))
    await db.saveMemoryDigest(digest('old-2'))
    await markMemorySynced()

    // 「删除所有对话」：暂存为空，提交后正式数据清空
    await db.clearStaging()
    await db.commitStaging()

    const { state } = await db.loadMemoryForSync()
    expect(state.digests).toEqual([])
    expect(state.deletedDigests).toHaveProperty('old-1')
    expect(state.deletedDigests).toHaveProperty('old-2')
    expect(await memoryDirty()).toBe(true)
    expect((await meta('sessions:old-1'))?.deletedAt).toBeDefined()
  })

  it('does not tombstone the digest when a deletion from another device is applied', async () => {
    await db.saveSession(session('remote-deleted'))
    await db.saveMemoryDigest(digest('remote-deleted'))
    await markMemorySynced()
    const current = await meta('sessions:remote-deleted')

    expect(await db.removeSyncedSession('remote-deleted', current?.modifiedAt)).toBe(true)

    // 删除它的那台设备负责把摘要的删除带到远端；本机只是跟上，不产生新的改动
    expect(await meta('sessions:remote-deleted')).toBeUndefined()
    expect(await memoryDirty()).toBe(false)
  })
})
