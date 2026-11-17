import { create } from 'zustand'
import * as db from '../chat/db.js'
import type { MemoryDigest, MemoryLogEntry, MemoryProfile } from '../chat/db.js'
import type { Session } from '../chat/types.js'
import { createId } from '../../utils/id.js'
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
/** 活动记录保留的条数 */
const LOG_LIMIT = 50

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
  /** 活动记录，由新到旧 */
  log: MemoryLogEntry[]
}

export const useMemory = create<MemoryState>(() => ({
  ready: false,
  profile: null,
  digests: [],
  pending: {},
  activity: 'idle',
  failed: false,
  log: [],
}))

const get = useMemory.getState
const set = useMemory.setState

const report = db.reportStorageError

/** 清空记忆或替换历史后递增；进行中的整理结果据此丢弃 */
let epoch = 0
/** 每个会话首次请求时的记忆块快照：同一会话内保持不变，利于缓存，也避免回答风格中途变化 */
/** 记忆块原文，以及其中近期对话对应的用户原话 */
type MemorySnapshot = ReturnType<typeof renderMemoryBlock>

const snapshots = new Map<string, MemorySnapshot>()
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

/**
 * 通知其他标签页重新读取，让另一个窗口的新会话也能立刻用上。
 * 只有活动记录变化时发 log，其他标签页只刷新记录，不作废已有会话的记忆快照。
 */
const broadcast = (what: 'changed' | 'log' = 'changed') => channel?.postMessage(what)

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

const sortLog = (log: MemoryLogEntry[]) => log.sort((a, b) => b.at - a.at)

const reloadLog = async () => set({ log: sortLog(await db.loadMemoryLog()) })

const reload = async () => {
  const [profile, digests, log] = await Promise.all([
    db.loadMemoryProfile(),
    db.loadMemoryDigests(),
    db.loadMemoryLog(),
  ])
  set({ ready: true, profile: profile ?? null, digests, log: sortLog(log) })
}

/** 生成摘要时附上不再提及的清单，新的摘要从源头上就不带这些事 */
const withMuted = (system: string, label: string): string => {
  const muted = get().profile?.muted ?? []
  return muted.length
    ? `${system}\n\n${label}\n${muted.map((item) => `- ${item}`).join('\n')}`
    : system
}

type DigestTrigger = 'delay' | 'leave' | 'catchUp' | 'manual'

/** 追加一条活动记录；写入失败只在控制台留痕，不影响整理本身 */
const appendLog = (entry: Omit<MemoryLogEntry, 'id' | 'at'>) => {
  const item: MemoryLogEntry = { id: createId(), at: Date.now(), ...entry }
  set((state) => ({ log: [item, ...state.log].slice(0, LOG_LIMIT) }))
  void db
    .addMemoryLogEntry(item, LOG_LIMIT)
    .then(() => broadcast('log'))
    .catch(report('write memory log'))
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message || error.name : String(error)

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
    channel?.addEventListener('message', (event: MessageEvent) => {
      if (event.data === 'log') {
        void reloadLog().catch(report('read memory log'))
        return
      }
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
 * 取会话要追加到 system 之后的记忆块；记忆关闭或没有内容时为空字符串。
 * sessionId 用于排除当前会话自身，并让同一会话沿用首次请求时的快照。
 * 调用方把同一个块保存到回答上，便于事后追溯这条回答参考了哪些记忆。
 */
export const getMemorySnapshot = (sessionId: string): MemorySnapshot => {
  if (!enabled()) {
    return { block: '', chats: [] }
  }
  let snapshot = snapshots.get(sessionId)
  if (snapshot === undefined) {
    const { profile, digests, pending } = get()
    snapshot = renderMemoryBlock({
      profile,
      digests,
      pending: Object.values(pending),
      currentSessionId: sessionId,
      locale: useSettings.getState().locale,
    })
    snapshots.set(sessionId, snapshot)
  }
  return snapshot
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
    window.setTimeout(() => startDigest(session.id, 'delay'), DIGEST_DELAY)
  )
}

const startDigest = (sessionId: string, trigger: DigestTrigger) => {
  window.clearTimeout(digestTimers.get(sessionId))
  digestTimers.delete(sessionId)
  const session = latestSessions.get(sessionId)
  latestSessions.delete(sessionId)
  if (!session) {
    return
  }
  void enqueue(async () => {
    const ok = await digestSession(session, trigger)
    if (ok) {
      await maybeDream(false)
    }
  }).catch(() => {})
}

/** 立即处理所有等待中的摘要：离开会话、切换窗口时调用 */
export const flushDigests = (trigger: 'leave' | 'manual' = 'leave') => {
  for (const sessionId of [...digestTimers.keys()]) {
    startDigest(sessionId, trigger)
  }
}

/** 生成并保存一个会话的摘要。返回是否成功；失败时保留原话节选，下次再试。 */
const digestSession = async (session: Session, trigger: DigestTrigger): Promise<boolean> => {
  const key = apiKey()
  if (!enabled() || !key) {
    return false
  }
  const startEpoch = epoch
  const startedAt = Date.now()
  const locale = useSettings.getState().locale
  const base = { kind: 'digest', trigger, sessionId: session.id, title: session.title } as const
  setActivity('digesting')
  try {
    const output = await complete({
      apiKey: key,
      system: withMuted(getPrompts(locale).digestSystem, getPrompts(locale).digestMuted),
      user: buildTranscript(session, locale),
    })
    // 期间清空了记忆或替换了历史：结果和记录都丢弃
    if (startEpoch !== epoch) {
      return false
    }
    const digest: MemoryDigest = {
      sessionId: session.id,
      title: session.title,
      summary: parseDigestOutput(output),
      excerpt: buildExcerpt(session),
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
    appendLog({
      ...base,
      durationMs: Date.now() - startedAt,
      result: digest.summary ? 'saved' : 'skipped',
      detail: digest.summary,
    })
    return true
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[memory] digest failed', error)
    set({ failed: true })
    if (startEpoch === epoch) {
      appendLog({
        ...base,
        durationMs: Date.now() - startedAt,
        result: 'failed',
        detail: errorMessage(error),
      })
    }
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
    const trigger: MemoryLogEntry['trigger'] | null = force
      ? 'manual'
      : !profile?.content.trim()
        ? 'first'
        : fresh.length >= DREAM_BATCH
          ? 'batch'
          : Date.now() - profile.dreamedAt > DREAM_INTERVAL
            ? 'interval'
            : null
    if (!trigger) {
      return false
    }
    const startEpoch = epoch
    const startUpdatedAt = profile?.updatedAt ?? 0
    const locale = useSettings.getState().locale
    const now = Date.now()
    const base = {
      kind: 'profile',
      trigger,
      sources: fresh.map((digest) => digest.title),
    } as const
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
      if (startEpoch !== epoch) {
        return false
      }
      const edited = (latest?.updatedAt ?? 0) !== startUpdatedAt
      if (edited || !content) {
        appendLog({
          ...base,
          durationMs: Date.now() - now,
          result: 'discarded',
          reason: edited ? 'edited' : 'emptyOutput',
          detail: content,
        })
        return false
      }
      const next: MemoryProfile = {
        id: 'profile',
        content,
        updatedAt: now,
        dreamedAt: now,
        muted: latest?.muted,
        unscrubbed: latest?.unscrubbed,
      }
      await db.saveMemoryProfile(next)
      set({ profile: next, failed: false })
      broadcast()
      appendLog({ ...base, durationMs: Date.now() - now, result: 'saved', detail: content })
      return true
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[memory] profile update failed', error)
      set({ failed: true })
      if (startEpoch === epoch) {
        appendLog({
          ...base,
          durationMs: Date.now() - now,
          result: 'failed',
          detail: errorMessage(error),
        })
      }
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
const backfill = async (limit: number, trigger: 'catchUp' | 'manual'): Promise<number> => {
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
    if (await digestSession(session, trigger)) {
      count += 1
    }
  }
  return count
}

/** 给记录用户原话之前生成的旧摘要补上原话节选；只读本地数据，不调用模型 */
const backfillExcerpts = async () => {
  const startEpoch = epoch
  const updated: MemoryDigest[] = []
  for (const digest of get().digests) {
    if (digest.summary && digest.excerpt === undefined) {
      const session = await db.loadSession(digest.sessionId)
      updated.push({ ...digest, excerpt: session ? buildExcerpt(session) : '' })
    }
  }
  if (!updated.length || startEpoch !== epoch) {
    return
  }
  await Promise.all(updated.map((digest) => db.saveMemoryDigest(digest)))
  const bySession = new Map(updated.map((digest) => [digest.sessionId, digest]))
  set((state) => ({
    // 期间重新生成过的摘要已经带上原话，以它为准
    digests: state.digests.map((digest) =>
      digest.excerpt === undefined ? (bySession.get(digest.sessionId) ?? digest) : digest
    ),
  }))
  invalidateSnapshots()
}

/** 启动时补上关闭页面前没来得及生成的摘要，并按需整理档案 */
const catchUp = () =>
  enqueue(async () => {
    if (!enabled()) {
      return
    }
    await backfillExcerpts()
    if (!apiKey()) {
      return
    }
    // 上次没能清理完的「不再提及」（当时记忆关闭、没有 API Key 或请求失败）
    await scrubDigests().catch(report('scrub memory digests'))
    await backfill(CATCH_UP_LIMIT, 'catchUp')
    await maybeDream(false)
  }).catch(report('memory catch-up'))

export type OrganizeResult = { digested: number; profileUpdated: boolean }

/** 手动「立即整理」：补齐最近会话的摘要并强制整理档案 */
export const organizeMemory = (): Promise<OrganizeResult> => {
  flushDigests('manual')
  return enqueue(async () => {
    const digested = await backfill(ORGANIZE_LIMIT, 'manual')
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
    muted: get().profile?.muted,
    unscrubbed: get().profile?.unscrubbed,
  }
  await db.saveMemoryProfile(profile)
  set({ profile })
  invalidateSnapshots()
  broadcast()
}

/** 档案里一行的正文：去掉缩进和列表符号，与来源面板里展示的条目一致 */
const lineText = (line: string) => line.trim().replace(/^[-*]\s+/, '')

const findProfileLine = (text: string): { lines: string[]; index: number } => {
  const lines = (get().profile?.content ?? '').split('\n')
  return { lines, index: lines.findIndex((line) => lineText(line) === text) }
}

/**
 * 更正档案里的一条：按原文找到那一行并替换，corrected 为空则删除这一行。
 * 档案之后已经变了、找不到原文时返回 false，由界面引导用户直接编辑档案。
 */
export const correctProfileItem = async (original: string, corrected: string): Promise<boolean> => {
  const { lines, index } = findProfileLine(original)
  if (index === -1) {
    return false
  }
  const next = corrected.replace(/\s+/g, ' ').trim()
  const prefix = lines[index].match(/^\s*(?:[-*]\s+)?/)?.[0] ?? ''
  lines.splice(index, 1, ...(next ? [`${prefix}${next}`] : []))
  await saveProfile(lines.join('\n'))
  return true
}

type Unscrubbed = NonNullable<MemoryProfile['unscrubbed']>

const saveMuted = async (content: string, muted: string[], unscrubbed: Unscrubbed) => {
  const current = get().profile
  const profile: MemoryProfile = {
    id: 'profile',
    content,
    // 视为用户编辑：下次整理会把现有档案当作用户确认过的内容
    updatedAt: Date.now(),
    dreamedAt: current?.dreamedAt ?? 0,
    muted: muted.length ? muted : undefined,
    unscrubbed: unscrubbed.length ? unscrubbed : undefined,
  }
  await db.saveMemoryProfile(profile)
  set({ profile })
  invalidateSnapshots()
  broadcast()
}

/**
 * 「别再提这件事」：从档案里删掉这一条，并记入不再提及的清单。
 * 只删档案不够：近期对话的摘要里还有这件事，会原样注入，下次整理也会重新归纳出来。
 * 所以清单会交给之后的摘要和整理，已有摘要里的相关内容用一次模型调用删掉；
 * 清理完成之前（包括记忆关闭、没有 API Key、请求失败），旧摘要不注入，之后启动或重新开启时重试。
 */
export const muteProfileItem = async (text: string): Promise<void> => {
  const { lines, index } = findProfileLine(text)
  if (index !== -1) {
    lines.splice(index, 1)
  }
  const current = get().profile
  const muted = current?.muted ?? []
  await saveMuted(lines.join('\n').trim(), muted.includes(text) ? muted : [...muted, text], [
    ...(current?.unscrubbed ?? []).filter((item) => item.text !== text),
    { text, at: Date.now() },
  ])
  void enqueue(scrubDigests).catch(report('scrub memory digests'))
}

/** 清理完成后把条目移出待清理列表；不动 updatedAt，这不是用户对档案的编辑 */
const markScrubbed = async (text: string) => {
  const current = get().profile
  if (!current) {
    return
  }
  const unscrubbed = (current.unscrubbed ?? []).filter((item) => item.text !== text)
  const profile: MemoryProfile = {
    ...current,
    unscrubbed: unscrubbed.length ? unscrubbed : undefined,
  }
  await db.saveMemoryProfile(profile)
  set({ profile })
  invalidateSnapshots()
  broadcast()
}

/**
 * 逐条处理还没清理的「不再提及」：把已有摘要里的相关内容删掉。
 * 记忆关闭或没有 API Key 时什么都不做，条目留在待清理列表里；请求失败同样保留，下次再试。
 * 需在串行队列里调用。
 */
const scrubDigests = async () => {
  const key = apiKey()
  if (!enabled() || !key) {
    return
  }
  const startEpoch = epoch
  const prompts = getPrompts(useSettings.getState().locale)
  const flat = (summary: string) => summary.replace(/\s+/g, ' ').trim()
  for (const item of get().profile?.unscrubbed ?? []) {
    // 这之后生成的摘要已经避开了这件事，不用再处理
    const targets = get().digests.filter((digest) => digest.summary && digest.digestedAt < item.at)
    if (!targets.length) {
      await markScrubbed(item.text)
      continue
    }
    setActivity('digesting')
    try {
      const output = await complete({
        apiKey: key,
        system: prompts.scrubSystem,
        user: [
          `${prompts.scrubTarget}:\n${item.text}`,
          `${prompts.scrubNotes}:\n${targets
            .map((digest, index) => `[${index + 1}] ${flat(digest.summary)}`)
            .join('\n')}`,
        ].join('\n\n'),
      })
      if (startEpoch !== epoch) {
        return
      }
      const changed: MemoryDigest[] = []
      for (const line of output.split('\n')) {
        const match = line.match(/^\s*\[(\d+)\]\s*(.*)$/)
        const target = match ? targets[Number(match[1]) - 1] : undefined
        if (!match || !target) {
          continue
        }
        const summary = parseDigestOutput(match[2])
        if (summary !== flat(target.summary)) {
          // 摘要被整条删掉时，用户原话也不再保留，来源面板里不会再出现
          changed.push({ ...target, summary, excerpt: summary ? target.excerpt : '' })
        }
      }
      await Promise.all(changed.map((digest) => db.saveMemoryDigest(digest)))
      const bySession = new Map(changed.map((digest) => [digest.sessionId, digest]))
      set((state) => ({
        digests: state.digests.map((digest) => bySession.get(digest.sessionId) ?? digest),
      }))
      await markScrubbed(item.text)
    } finally {
      setActivity('idle')
    }
  }
}

/** 从不再提及的清单里移除一条；不会自动写回档案，之后的整理可以重新记录 */
export const unmuteItem = async (text: string): Promise<void> => {
  const current = get().profile
  await saveMuted(
    current?.content ?? '',
    (current?.muted ?? []).filter((item) => item !== text),
    (current?.unscrubbed ?? []).filter((item) => item.text !== text)
  )
}

/**
 * 档案里一条记忆的来源：最早写出这一行的那次整理，以及当时并入的对话。
 * 档案是整篇重写的，没有逐行出处，只能从活动记录里反查；
 * 查不到（手动写的，或记录已超出保留条数）时返回 null。
 */
export const findProfileOrigin = (text: string): { at: number; sources: string[] } | null => {
  const origin = get()
    .log.filter(
      (entry) =>
        entry.kind === 'profile' &&
        entry.result === 'saved' &&
        entry.detail.split('\n').some((line) => lineText(line) === text)
    )
    .at(-1)
  return origin ? { at: origin.at, sources: origin.sources ?? [] } : null
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
  // 活动记录里有这条摘要的原文，一并删除
  await db.deleteMemoryLogForSession(sessionId)
  set((state) => ({
    digests: state.digests.map((digest) => (digest.sessionId === sessionId ? tombstone : digest)),
    log: state.log.filter((entry) => entry.sessionId !== sessionId),
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
  set((state) => ({
    digests: state.digests.filter((digest) => digest.sessionId !== sessionId),
    log: state.log.filter((entry) => entry.sessionId !== sessionId),
  }))
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
  set({ digests: [], pending: {}, log: [] })
  broadcast()
}

/** 清空全部记忆（近期摘要与档案）；对话不受影响 */
export const clearMemory = async (): Promise<void> => {
  resetVolatile()
  await db.clearMemory()
  writeClearedAt(Date.now())
  set({ profile: null, digests: [], pending: {}, failed: false, log: [] })
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
