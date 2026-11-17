import { create } from 'zustand'
import * as db from '../chat/db.js'
import type { MemoryDigest, MemoryLogEntry, MemoryPlan, MemoryProfile } from '../chat/db.js'
import type { MemoryItem } from '../chat/types.js'
import { createId } from '../../utils/id.js'
import { isNativeProvider, useSettings } from '../settings.js'
import type { MemorySnapshot, PendingExcerpt } from './text.js'

/**
 * 记忆的共享状态：store.ts（整理与调度）和 items.ts（用户操作）都通过这里读写。
 * 所有写入都走 commit：一个 IndexedDB 事务基于最新数据计算并写入，之后重新读取，
 * 多个标签页、并发的整理与用户操作不会互相覆盖。
 */

/** 活动记录保留的条数 */
export const LOG_LIMIT = 50

export type MemoryActivity = 'idle' | 'digesting' | 'dreaming'

type MemoryState = {
  ready: boolean
  /** 元数据：不再提及、待清理、删除过的内容、上次整理时间 */
  profile: MemoryProfile | null
  /** 全部条目，含待确认的 */
  items: MemoryItem[]
  digests: MemoryDigest[]
  /** 摘要落后的会话，键为会话 id；只在内存中，摘要生成后移除 */
  pending: Record<string, PendingExcerpt>
  activity: MemoryActivity
  /** 最近一次自动整理是否失败；成功后清除 */
  failed: boolean
  /** 活动记录，由新到旧 */
  log: MemoryLogEntry[]
}

export const useMemory = create<MemoryState>(() => ({
  ready: false,
  profile: null,
  items: [],
  digests: [],
  pending: {},
  activity: 'idle',
  failed: false,
  log: [],
}))

export const getMemory = useMemory.getState
export const setMemory = useMemory.setState

export const report = db.reportStorageError

export const memoryEnabled = () => useSettings.getState().memoryEnabled
/** 整理走 DeepSeek；选择其他服务商时不向 DeepSeek 发送对话。 */
export const memoryApiKey = () => (isNativeProvider() ? useSettings.getState().apiKey : null)

/** 清空记忆或替换历史后递增；进行中的整理结果据此丢弃 */
let epoch = 0
export const currentEpoch = () => epoch
export const bumpEpoch = () => {
  epoch += 1
}

/** 每个会话首次请求时的记忆块快照：同一会话内保持不变，利于缓存，也避免回答风格中途变化 */
export const snapshots = new Map<string, MemorySnapshot>()
/** 用户改动记忆（编辑、删除、开关）后，已打开的会话也立即按新内容注入 */
export const invalidateSnapshots = () => snapshots.clear()

/** 模型调用串行执行，避免并发整理互相覆盖 */
let queue: Promise<unknown> = Promise.resolve()
export const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}

export const channel =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('chat-demo:memory')

/**
 * 通知其他标签页重新读取，让另一个窗口的新会话也能立刻用上。
 * 只有活动记录变化时发 log，其他标签页只刷新记录，不作废已有会话的记忆快照。
 */
export const broadcast = (what: 'changed' | 'log' = 'changed') => channel?.postMessage(what)

/** 上次清空记忆的时间：此前的对话不再自动整理，避免清空后又从旧对话里长回来；各标签页共用 */
const CLEARED_AT_KEY = 'chat-demo:memory-cleared-at'
export const readClearedAt = (): number => {
  try {
    return Number(localStorage.getItem(CLEARED_AT_KEY)) || 0
  } catch {
    return 0
  }
}
export const writeClearedAt = (value: number) => {
  try {
    localStorage.setItem(CLEARED_AT_KEY, String(value))
  } catch {
    // 存储不可用时只影响是否补生成，不影响清空本身
  }
}

const sortLog = (log: MemoryLogEntry[]) => log.sort((a, b) => b.at - a.at)

export const reloadLog = async () => setMemory({ log: sortLog(await db.loadMemoryLog()) })

/** 读取期间又发起了新的读取或写入时，旧的结果不再使用 */
let loadSequence = 0

export const reload = async () => {
  const sequence = (loadSequence += 1)
  const [profile, digests, log, items] = await Promise.all([
    db.loadMemoryProfile(),
    db.loadMemoryDigests(),
    db.loadMemoryLog(),
    db.loadMemoryItems(),
  ])
  if (sequence !== loadSequence) {
    return
  }
  setMemory((state) => ({
    ready: true,
    profile: profile ?? null,
    digests,
    items,
    log: sortLog(log),
    // 其他标签页已经为这些会话生成了摘要，原话节选不再需要
    pending: Object.fromEntries(
      Object.entries(state.pending).filter(([id, item]) => {
        const digest = digests.find((entry) => entry.sessionId === id)
        return !digest || digest.updatedAt < item.updatedAt
      })
    ),
  }))
}

/**
 * 在一个事务里计算并写入记忆的改动，写入后重新读取并通知其他标签页。
 * invalidate 为 true 时作废已打开会话的记忆快照，下一轮按新内容注入（用户的改动、删除都应如此）。
 */
export const commit = async ({
  sessionId,
  invalidate,
  plan,
}: {
  sessionId?: string
  invalidate: boolean
  plan: Parameters<typeof db.commitMemory>[0]['plan']
}): Promise<MemoryPlan | null> => {
  const result = await db.commitMemory({ sessionId, logLimit: LOG_LIMIT, plan })
  if (result) {
    await reload()
    if (invalidate) {
      invalidateSnapshots()
    }
    broadcast()
  }
  return result
}

/** 元数据的初始值：还没有任何记录时使用 */
export const emptyProfile = (): MemoryProfile => ({
  id: 'profile',
  content: '',
  updatedAt: 0,
  dreamedAt: 0,
})

/** 追加一条只有记录、没有数据改动的活动记录（失败、作废）；写入失败只在控制台留痕 */
export const appendLog = (entry: Omit<MemoryLogEntry, 'id' | 'at'>) => {
  const item: MemoryLogEntry = { id: createId(), at: Date.now(), ...entry }
  setMemory((state) => ({ log: [item, ...state.log].slice(0, LOG_LIMIT) }))
  void db
    .addMemoryLogEntry(item, LOG_LIMIT)
    .then(() => broadcast('log'))
    .catch(report('write memory log'))
}

export const logEntry = (entry: Omit<MemoryLogEntry, 'id' | 'at'>): MemoryLogEntry => ({
  id: createId(),
  at: Date.now(),
  ...entry,
})

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message || error.name : String(error)

export const setActivity = (activity: MemoryActivity) => setMemory({ activity })
