import { create } from 'zustand'
import * as db from '../chat/db.js'
import type { MemoryDigest, MemoryProfile } from '../chat/db.js'
import type { Session } from '../chat/types.js'
import { useSettings } from '../settings.js'
import { complete } from './llm.js'
import { getPrompts } from './prompts.js'
import {
  buildDreamInput,
  buildExcerpt,
  buildTranscript,
  isDigestFresh,
  isDigestible,
  parseDigestOutput,
  parseProfileOutput,
  renderMemoryBlock,
  visibleCount,
  type PendingExcerpt,
} from './text.js'

/**
 * 记忆分两层，都预先算好并整段注入 system，模型无需检索：
 * - 近期对话摘要：每个会话一条，回答完成后很快生成，让新会话立刻知道之前聊了什么；
 * - 用户档案：后台定期把新摘要并入并整体重写，沉淀长期稳定的信息。
 * 全部数据存放在本机 IndexedDB，用户可在设置中查看、编辑和删除。
 */

/** 回答完成后等待这么久再生成摘要，连续追问时只生成一次 */
const DIGEST_DELAY = 8000
/** 累计这么多条未并入的摘要就整理档案 */
const DREAM_BATCH = 3
/** 有未并入的摘要且距上次整理超过这个时间也整理 */
const DREAM_INTERVAL = 6 * 60 * 60 * 1000
/** 启动时为最近这么多个会话补生成摘要 */
const CATCH_UP_LIMIT = 3
/** 手动整理时补生成摘要的会话数上限 */
const ORGANIZE_LIMIT = 20

export type MemoryActivity = 'idle' | 'digesting' | 'dreaming'

type MemoryState = {
  ready: boolean
  profile: MemoryProfile | null
  digests: MemoryDigest[]
  /** 摘要落后的会话，键为会话 id；只在内存中，摘要生成后移除 */
  pending: Record<string, PendingExcerpt>
  activity: MemoryActivity
  /** 最近一次自动整理是否失败；成功后清除 */
  failed: boolean
}

export const useMemory = create<MemoryState>(() => ({
  ready: false,
  profile: null,
  digests: [],
  pending: {},
  activity: 'idle',
  failed: false,
}))

const get = useMemory.getState
const set = useMemory.setState

const report = db.reportStorageError

/** 清空记忆或替换历史后递增；进行中的整理结果据此丢弃 */
let epoch = 0
/** 每个会话首次请求时的记忆块快照：同一会话内保持不变，利于缓存，也避免回答风格中途变化 */
const snapshots = new Map<string, string>()
const digestTimers = new Map<string, number>()
/** 等待摘要的会话的最新内容 */
const latestSessions = new Map<string, Session>()

/** 所有模型调用串行执行，避免并发整理互相覆盖 */
let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}

const channel =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('chat-demo:memory')

/** 通知其他标签页重新读取，让另一个窗口的新会话也能立刻用上 */
const broadcast = () => channel?.postMessage('changed')

/** 上次清空记忆的时间：此前的对话不再自动补生成摘要，避免清空后又从旧对话里长回来 */
const CLEARED_AT_KEY = 'chat-demo:memory-cleared-at'
const readClearedAt = (): number => {
  try {
    return Number(localStorage.getItem(CLEARED_AT_KEY)) || 0
  } catch {
    return 0
  }
}
const writeClearedAt = (value: number) => {
  try {
    localStorage.setItem(CLEARED_AT_KEY, String(value))
  } catch {
    // 存储不可用时只影响是否补生成，不影响清空本身
  }
}

/** 与 settings.ts 中记忆开关的 localStorage 键一致 */
const MEMORY_ENABLED_KEY = 'chat-demo:memory-enabled'

const enabled = () => useSettings.getState().memoryEnabled
const apiKey = () => useSettings.getState().apiKey

const reload = async () => {
  const [profile, digests] = await Promise.all([db.loadMemoryProfile(), db.loadMemoryDigests()])
  set({ ready: true, profile: profile ?? null, digests })
}

/** 用户改动记忆（编辑、删除、开关）后，已打开的会话也立即按新内容注入 */
const invalidateSnapshots = () => snapshots.clear()

let initTask: Promise<void> | undefined

export const initMemory = (): Promise<void> => {
  initTask ??= (async () => {
    try {
      await reload()
    } catch (error) {
      report('read memory')(error)
      set({ ready: true })
    }
    channel?.addEventListener('message', () => {
      invalidateSnapshots()
      void reload().catch(report('read memory'))
    })
    // 记忆开关在其他标签页被改动时同步过来：关闭后所有标签页都应停止整理与注入
    window.addEventListener('storage', (event) => {
      if (event.key === MEMORY_ENABLED_KEY) {
        useSettings.setState({ memoryEnabled: event.newValue !== 'false' })
        onMemoryToggled()
      }
    })
    // 切到其他窗口或标签页时立即生成待处理的摘要，不等延时
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushDigests()
      }
    })
    void catchUp()
  })()
  return initTask
}

/**
 * 取会话的记忆块并追加到 system 之后。记忆关闭或没有内容时原样返回。
 * sessionId 用于排除当前会话自身，并让同一会话沿用首次请求时的快照。
 */
export const withMemory = (system: string, sessionId: string): string => {
  if (!enabled()) {
    return system
  }
  let block = snapshots.get(sessionId)
  if (block === undefined) {
    const { profile, digests, pending } = get()
    block = renderMemoryBlock({
      profile,
      digests,
      pending: Object.values(pending),
      currentSessionId: sessionId,
      locale: useSettings.getState().locale,
    })
    snapshots.set(sessionId, block)
  }
  return block ? `${system}\n\n${block}` : system
}

const setActivity = (activity: MemoryActivity) => set({ activity })

const removePending = (sessionId: string) =>
  set((state) => ({
    pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== sessionId)),
  }))

/**
 * 回答正常完成后调用：先记下用户原话节选（新会话立即可用），再延时生成摘要。
 */
export const noteReplyDone = (session: Session) => {
  if (!enabled() || !isDigestible(session)) {
    return
  }
  latestSessions.set(session.id, session)
  set((state) => ({
    pending: {
      ...state.pending,
      [session.id]: {
        sessionId: session.id,
        title: session.title,
        excerpt: buildExcerpt(session),
        updatedAt: session.updatedAt,
      },
    },
  }))
  window.clearTimeout(digestTimers.get(session.id))
  digestTimers.set(
    session.id,
    window.setTimeout(() => startDigest(session.id), DIGEST_DELAY)
  )
}

const startDigest = (sessionId: string) => {
  window.clearTimeout(digestTimers.get(sessionId))
  digestTimers.delete(sessionId)
  const session = latestSessions.get(sessionId)
  latestSessions.delete(sessionId)
  if (!session) {
    return
  }
  void enqueue(async () => {
    const ok = await digestSession(session)
    if (ok) {
      await maybeDream(false)
    }
  }).catch(() => {})
}

/** 立即处理所有等待中的摘要：离开会话、切换窗口时调用 */
export const flushDigests = () => {
  for (const sessionId of [...digestTimers.keys()]) {
    startDigest(sessionId)
  }
}

/** 生成并保存一个会话的摘要。返回是否成功；失败时保留原话节选，下次再试。 */
const digestSession = async (session: Session): Promise<boolean> => {
  const key = apiKey()
  if (!enabled() || !key) {
    return false
  }
  const startEpoch = epoch
  const locale = useSettings.getState().locale
  setActivity('digesting')
  try {
    const output = await complete({
      apiKey: key,
      system: getPrompts(locale).digestSystem,
      user: buildTranscript(session, locale),
    })
    if (startEpoch !== epoch) {
      return false
    }
    const digest: MemoryDigest = {
      sessionId: session.id,
      title: session.title,
      summary: parseDigestOutput(output),
      updatedAt: session.updatedAt,
      digestedAt: Date.now(),
      messageCount: visibleCount(session),
    }
    await db.saveMemoryDigest(digest)
    set((state) => ({
      failed: false,
      digests: [...state.digests.filter((item) => item.sessionId !== session.id), digest],
    }))
    // 期间又有新回答时保留节选，等下一次摘要
    if (!latestSessions.has(session.id)) {
      removePending(session.id)
    }
    broadcast()
    return true
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[memory] digest failed', error)
    set({ failed: true })
    return false
  } finally {
    setActivity('idle')
  }
}

const undreamed = (digests: MemoryDigest[], profile: MemoryProfile | null) =>
  digests.filter((digest) => digest.summary && digest.digestedAt > (profile?.dreamedAt ?? 0))

/**
 * 整理用户档案：把尚未并入的摘要和现有档案交给模型整体重写。
 * force 为 false 时按批量与间隔判断是否需要；返回是否写入了新档案。
 * 多个标签页通过 Web Locks 互斥，整理前重新读取，避免覆盖其他标签页或用户刚做的修改。
 */
const maybeDream = async (force: boolean): Promise<boolean> => {
  const key = apiKey()
  if (!enabled() || !key) {
    return false
  }
  const run = async (): Promise<boolean> => {
    await reload()
    const { profile, digests } = get()
    const fresh = undreamed(digests, profile)
    if (!fresh.length) {
      return false
    }
    const due =
      force ||
      !profile?.content.trim() ||
      fresh.length >= DREAM_BATCH ||
      Date.now() - profile.dreamedAt > DREAM_INTERVAL
    if (!due) {
      return false
    }
    const startEpoch = epoch
    const startUpdatedAt = profile?.updatedAt ?? 0
    const locale = useSettings.getState().locale
    const now = Date.now()
    setActivity('dreaming')
    try {
      const output = await complete({
        apiKey: key,
        system: getPrompts(locale).dreamSystem,
        user: buildDreamInput({ profile, digests: fresh, now, locale }),
      })
      const content = parseProfileOutput(output)
      // 用户在整理期间清空或编辑了记忆时，以用户的操作为准，本次结果作废
      const latest = await db.loadMemoryProfile()
      if (startEpoch !== epoch || (latest?.updatedAt ?? 0) !== startUpdatedAt || !content) {
        return false
      }
      const next: MemoryProfile = { id: 'profile', content, updatedAt: now, dreamedAt: now }
      await db.saveMemoryProfile(next)
      set({ profile: next, failed: false })
      broadcast()
      return true
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[memory] profile update failed', error)
      set({ failed: true })
      return false
    } finally {
      setActivity('idle')
    }
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return (
      (await navigator.locks.request('chat-demo:memory-dream', { ifAvailable: true }, (lock) =>
        lock ? run() : false
      )) ?? false
    )
  }
  return run()
}

/** 为最近的若干会话补生成缺失或落后的摘要，返回新生成的条数 */
const backfill = async (limit: number): Promise<number> => {
  const clearedAt = readClearedAt()
  const summaries = (await db.loadSessionSummaries())
    .filter((summary) => summary.updatedAt > clearedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
  let count = 0
  for (const summary of summaries) {
    if (!enabled() || !apiKey()) {
      break
    }
    const existing = get().digests.find((digest) => digest.sessionId === summary.id)
    // 先用列表里的时间粗筛，避免逐个读取完整会话
    if (existing && existing.updatedAt >= summary.updatedAt) {
      continue
    }
    const session = await db.loadSession(summary.id)
    if (!session || !isDigestible(session) || isDigestFresh(existing, session)) {
      continue
    }
    if (await digestSession(session)) {
      count += 1
    }
  }
  return count
}

/** 启动时补上关闭页面前没来得及生成的摘要，并按需整理档案 */
const catchUp = () =>
  enqueue(async () => {
    if (!enabled() || !apiKey()) {
      return
    }
    await backfill(CATCH_UP_LIMIT)
    await maybeDream(false)
  }).catch(report('memory catch-up'))

export type OrganizeResult = { digested: number; profileUpdated: boolean }

/** 手动「立即整理」：补齐最近会话的摘要并强制整理档案 */
export const organizeMemory = (): Promise<OrganizeResult> => {
  flushDigests()
  return enqueue(async () => {
    const digested = await backfill(ORGANIZE_LIMIT)
    const profileUpdated = await maybeDream(true)
    if (get().failed) {
      throw new Error('Memory organization failed')
    }
    return { digested, profileUpdated }
  })
}

/** 用户手动保存档案；内容为空即清空档案。之后的自动整理会把它视为用户确认过的内容。 */
export const saveProfile = async (content: string): Promise<void> => {
  const profile: MemoryProfile = {
    id: 'profile',
    content: content.trim(),
    updatedAt: Date.now(),
    dreamedAt: get().profile?.dreamedAt ?? 0,
  }
  await db.saveMemoryProfile(profile)
  set({ profile })
  invalidateSnapshots()
  broadcast()
}

/** 删除一条近期对话摘要；对话本身保留，也不会再为同样的内容重新生成。 */
export const forgetDigest = async (sessionId: string): Promise<void> => {
  const existing = get().digests.find((digest) => digest.sessionId === sessionId)
  if (!existing) {
    return
  }
  // 保留一条空摘要作为「已处理」标记，否则下次启动会被补生成回来
  const tombstone: MemoryDigest = { ...existing, summary: '' }
  await db.saveMemoryDigest(tombstone)
  set((state) => ({
    digests: state.digests.map((digest) => (digest.sessionId === sessionId ? tombstone : digest)),
  }))
  removePending(sessionId)
  invalidateSnapshots()
  broadcast()
}

const dropSession = (sessionId: string) => {
  window.clearTimeout(digestTimers.get(sessionId))
  digestTimers.delete(sessionId)
  latestSessions.delete(sessionId)
  snapshots.delete(sessionId)
}

/** 对话被删除后同步内存状态（数据库中的摘要已在同一事务中删除） */
export const onSessionRemoved = (sessionId: string) => {
  dropSession(sessionId)
  removePending(sessionId)
  set((state) => ({ digests: state.digests.filter((digest) => digest.sessionId !== sessionId) }))
  invalidateSnapshots()
  broadcast()
}

const resetVolatile = () => {
  epoch += 1
  for (const timer of digestTimers.values()) {
    window.clearTimeout(timer)
  }
  digestTimers.clear()
  latestSessions.clear()
  invalidateSnapshots()
}

/** 历史被导入或全部删除后：近期摘要随会话一起清空，用户档案保留 */
export const onHistoryReplaced = () => {
  resetVolatile()
  set({ digests: [], pending: {} })
  broadcast()
}

/** 清空全部记忆（近期摘要与档案）；对话不受影响 */
export const clearMemory = async (): Promise<void> => {
  resetVolatile()
  await db.clearMemory()
  writeClearedAt(Date.now())
  set({ profile: null, digests: [], pending: {}, failed: false })
  broadcast()
}

/** 开关变化：关闭时取消待处理的摘要；重新开启后补上最近的会话 */
export const onMemoryToggled = () => {
  invalidateSnapshots()
  if (enabled()) {
    void catchUp()
  } else {
    for (const timer of digestTimers.values()) {
      window.clearTimeout(timer)
    }
    digestTimers.clear()
    latestSessions.clear()
    set({ pending: {} })
  }
}
