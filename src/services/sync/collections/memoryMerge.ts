import type { MemoryDigest, MemoryProfile, MemorySyncState } from '../../chat/db.js'
import type { MemoryItem } from '../../chat/types.js'

/**
 * 记忆的合并：两台设备都改过记忆时，按条目合并，而不是整份取其中一边。纯函数。
 * 条目按 id 取较新的；删除、清空都带着时间，晚于条目最后变动的才生效；
 * 「不再提及」「删除过的内容」取并集；近期摘要按对话取较新的。
 */

export type MemorySyncData = MemorySyncState & {
  /** 上次清空记忆的时间：在它之前的条目和摘要都不再保留 */
  clearedAt: number
}

/** 与 memory/ops.ts 的 FORGOTTEN_LIMIT 一致：删除过的内容只留最近若干条 */
const FORGOTTEN_LIMIT = 50

const maxRecord = (a: Record<string, number>, b: Record<string, number>) => {
  const result: Record<string, number> = { ...a }
  for (const [key, at] of Object.entries(b)) {
    result[key] = Math.max(at, result[key] ?? 0)
  }
  return result
}

const comparable = (text: string) => text.trim().toLowerCase()

const unionByText = <T extends { text: string; at: number }>(a: T[] = [], b: T[] = []): T[] => {
  const byText = new Map<string, T>()
  for (const entry of [...a, ...b]) {
    const key = comparable(entry.text)
    const existing = byText.get(key)
    if (!existing || entry.at > existing.at) {
      byText.set(key, entry)
    }
  }
  return [...byText.values()].sort((x, y) => x.at - y.at)
}

const mergeProfile = (
  local: MemoryProfile | null,
  remote: MemoryProfile | null
): MemoryProfile | null => {
  if (!local || !remote) {
    return local ?? remote
  }
  const newer = remote.updatedAt > local.updatedAt ? remote : local
  const muted = [...new Set([...(local.muted ?? []), ...(remote.muted ?? [])])]
  const unscrubbed = unionByText(local.unscrubbed, remote.unscrubbed)
  const forgotten = unionByText(local.forgotten, remote.forgotten).slice(-FORGOTTEN_LIMIT)
  const migratedAt = Math.max(local.migratedAt ?? 0, remote.migratedAt ?? 0)
  return {
    id: 'profile',
    content: newer.content,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    dreamedAt: Math.max(local.dreamedAt, remote.dreamedAt),
    ...(muted.length ? { muted } : {}),
    ...(unscrubbed.length ? { unscrubbed } : {}),
    ...(forgotten.length ? { forgotten } : {}),
    ...(migratedAt ? { migratedAt } : {}),
  }
}

export const mergeMemory = (local: MemorySyncData, remote: MemorySyncData): MemorySyncData => {
  const clearedAt = Math.max(local.clearedAt, remote.clearedAt)
  const revivedItems = maxRecord(local.revivedItems, remote.revivedItems)
  const deletedItems = Object.fromEntries(
    Object.entries(maxRecord(local.deletedItems, remote.deletedItems)).filter(
      ([, at]) => at > clearedAt
    )
  )
  const deletedDigests = Object.fromEntries(
    Object.entries(maxRecord(local.deletedDigests, remote.deletedDigests)).filter(
      ([, at]) => at > clearedAt
    )
  )

  const byId = new Map<string, MemoryItem>()
  for (const item of [...local.items, ...remote.items]) {
    const existing = byId.get(item.id)
    if (!existing || item.updatedAt > existing.updatedAt) {
      byId.set(item.id, item)
    }
  }
  const seenText = new Set<string>()
  const items = [...byId.values()]
    .filter((item) => {
      // 删除后又放回（撤销删除）的条目 updatedAt 不变，以放回时间为准
      const touchedAt = Math.max(item.updatedAt, revivedItems[item.id] ?? 0)
      return touchedAt > clearedAt && touchedAt > (deletedItems[item.id] ?? 0)
    })
    .sort((a, b) => a.createdAt - b.createdAt)
    // 两台设备各自记下的同一句话只留较早的一条
    .filter((item) => {
      const key = comparable(item.text)
      if (seenText.has(key)) {
        return false
      }
      seenText.add(key)
      return true
    })

  const digestBySession = new Map<string, MemoryDigest>()
  for (const digest of [...local.digests, ...remote.digests]) {
    const existing = digestBySession.get(digest.sessionId)
    if (!existing || digest.digestedAt > existing.digestedAt) {
      digestBySession.set(digest.sessionId, digest)
    }
  }
  const digests = [...digestBySession.values()]
    .filter(
      (digest) =>
        digest.digestedAt > clearedAt && digest.digestedAt > (deletedDigests[digest.sessionId] ?? 0)
    )
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))

  const keepProfile = (profile: MemoryProfile | null) =>
    profile && Math.max(profile.updatedAt, profile.dreamedAt) >= clearedAt ? profile : null
  const liveIds = new Set(items.map((item) => item.id))
  return {
    items,
    // 清空之前的元数据随清空一起失效
    profile: mergeProfile(keepProfile(local.profile), keepProfile(remote.profile)),
    digests,
    deletedItems,
    revivedItems: Object.fromEntries(
      Object.entries(revivedItems).filter(([id]) => liveIds.has(id))
    ),
    deletedDigests,
    clearedAt,
  }
}
