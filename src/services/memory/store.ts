import * as db from '../chat/db.js'
import type { MemoryDigest, MemoryLogEntry, MemoryProfile } from '../chat/db.js'
import type { MemoryChange, MemoryItem, Session } from '../chat/types.js'
import { getVisibleMessages } from '../chat/branches.js'
import { createId } from '../../utils/id.js'
import { useSettings, type Locale } from '../settings.js'
import { complete } from './llm.js'
import { migrateProfile } from './migrate.js'
import {
  applyOps,
  FORGET_REQUEST,
  ITEM_LIMIT,
  parseModelOutput,
  REMEMBER_REQUEST,
  rememberForgotten,
  sameText,
  type OpResult,
} from './ops.js'
import { getPrompts } from './prompts.js'
import {
  appendLog,
  bumpEpoch,
  channel,
  commit,
  currentEpoch,
  emptyProfile,
  enqueue,
  errorMessage,
  getMemory,
  invalidateSnapshots,
  logEntry,
  memoryApiKey,
  memoryEnabled,
  readClearedAt,
  reload,
  reloadLog,
  report,
  setActivity,
  setMemory,
  snapshots,
  writeClearedAt,
} from './state.js'
import {
  buildConsolidateInput,
  buildExcerpt,
  buildExtractInput,
  buildTranscript,
  coveredAt,
  isDigestFresh,
  isDigestible,
  isHeld,
  latestMessageAt,
  parseDigestOutput,
  renderMemoryBlock,
  visibleCount,
  type MemorySnapshot,
} from './text.js'

export { useMemory, type MemoryActivity } from './state.js'

/**
 * 记忆的整理与调度。
 * - 回答完成后（快路径）：一次模型调用写出这段对话的备忘，并提出对记忆条目的增、改、删，按规则校验后落库；
 *   改动显示在对话里，可撤销。
 * - 后台（慢路径）：新摘要累计到一定数量或隔一段时间，把全部条目和新摘要交给模型合并、归纳、清理。
 * 记忆条目和近期对话摘要都预先算好，整段注入 system，模型无需检索。
 * 全部数据存放在本机 IndexedDB，用户可在设置中查看、编辑和删除。
 */

/** 回答完成后等待这么久再整理，连续追问时只整理一次 */
const DIGEST_DELAY = 4000
/** 用户明确要求记住或忘掉时几乎立即整理 */
const REQUEST_DELAY = 300
/** 累计这么多条未参与整理的摘要就后台整理 */
const DREAM_BATCH = 3
/** 有未参与整理的摘要且距上次整理超过这个时间也整理 */
const DREAM_INTERVAL = 6 * 60 * 60 * 1000
/** 启动时为最近这么多个会话补整理 */
const CATCH_UP_LIMIT = 3
/** 手动整理时补整理的会话数上限 */
const ORGANIZE_LIMIT = 20

/** 与 settings.ts 中记忆开关的 localStorage 键一致 */
const MEMORY_ENABLED_KEY = 'chat-demo:memory-enabled'

const digestTimers = new Map<string, number>()
/** 等待整理的会话的最新内容 */
const latestSessions = new Map<string, Session>()

/**
 * 把一次整理的改动交给聊天层，挂到对应的提问上显示。记忆层不依赖聊天层，由聊天层注册。
 */
type ChangeSink = (sessionId: string, messageId: string, changes: MemoryChange[]) => void
let changeSink: ChangeSink | null = null
export const setMemoryChangeSink = (sink: ChangeSink) => {
  changeSink = sink
}

/** 不要再记录的内容：删除过、拒绝过、等待确认和不再提及的 */
const avoidList = (profile: MemoryProfile | null, items: MemoryItem[]): string[] => [
  ...(profile?.forgotten ?? []).map((item) => item.text),
  ...items.filter((item) => item.status === 'pending').map((item) => item.text),
  ...(profile?.muted ?? []),
]

/** 只写备忘时附上不要记录的清单，新的摘要从源头上就不带这些事 */
const withAvoid = (system: string, locale: Locale): string => {
  const { profile, items } = getMemory()
  const avoid = avoidList(profile, items)
  return avoid.length
    ? `${system}\n\n${getPrompts(locale).digestMuted}\n${avoid.map((item) => `- ${item}`).join('\n')}`
    : system
}

type DigestTrigger = 'delay' | 'leave' | 'catchUp' | 'manual'

let initTask: Promise<void> | undefined

export const initMemory = (): Promise<void> => {
  initTask ??= (async () => {
    try {
      await reload()
      await migrate()
    } catch (error) {
      report('read memory')(error)
      setMemory({ ready: true })
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
    // 切到其他窗口或标签页时立即整理待处理的会话，不等延时
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
 * 旧版的 Markdown 档案迁移成逐条记忆，只做一次。检查和写入在同一个事务里，多个标签页同时启动也只迁移一次。
 * 原文保留在 content 里不删。
 */
const migrate = async () => {
  const profile = getMemory().profile
  if (!profile?.content.trim() || profile.migratedAt) {
    return
  }
  const now = Date.now()
  await commit({
    invalidate: true,
    plan: ({ items, profile: current }) => {
      if (!current?.content.trim() || current.migratedAt) {
        return null
      }
      const migrated = migrateProfile({
        content: current.content,
        // 用户手改过、或从没自动整理过（全是用户自己写的）的档案，视为用户确认过的内容
        userEdited: current.dreamedAt === 0 || current.updatedAt > current.dreamedAt,
        now,
        createId,
      }).filter((item) => !items.some((existing) => sameText(existing.text, item.text)))
      return { putItems: migrated, profile: { ...current, migratedAt: now } }
    },
  })
}

/**
 * 取会话要追加到 system 之后的记忆块；记忆关闭或没有内容时为空字符串。
 * sessionId 用于排除当前会话自身，并让同一会话沿用首次请求时的快照。
 * 调用方把同一个块保存到回答上，便于事后追溯这条回答参考了哪些记忆。临时对话由调用方跳过。
 */
export const getMemorySnapshot = (sessionId: string): MemorySnapshot => {
  if (!memoryEnabled()) {
    return { block: '', chats: [], ids: {} }
  }
  let snapshot = snapshots.get(sessionId)
  if (snapshot === undefined) {
    const { profile, items, digests, pending } = getMemory()
    snapshot = renderMemoryBlock({
      profile,
      items,
      digests,
      pending: Object.values(pending),
      currentSessionId: sessionId,
      locale: useSettings.getState().locale,
    })
    snapshots.set(sessionId, snapshot)
  }
  return snapshot
}

/** 追加在助手身份说明之后的记忆说明：记忆开启时告诉模型可以答应记住或忘掉，临时对话说明不会保存 */
export const getMemoryGuidance = (temporary: boolean): string => {
  const prompts = getPrompts(useSettings.getState().locale)
  return temporary ? prompts.temporary : memoryEnabled() ? prompts.capability : ''
}

const removePending = (sessionId: string) =>
  setMemory((state) => ({
    pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== sessionId)),
  }))

/**
 * 回答正常完成后调用：先记下用户原话节选（新会话立即可用），再延时整理。
 * 用户明确要求记住或忘掉时几乎不等。
 */
export const noteReplyDone = (session: Session) => {
  if (!memoryEnabled() || !isDigestible(session)) {
    return
  }
  latestSessions.set(session.id, session)
  setMemory((state) => ({
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
  const lastQuestion = getVisibleMessages(session).findLast((message) => message.role === 'user')
  const requested =
    lastQuestion?.role === 'user' &&
    (REMEMBER_REQUEST.test(lastQuestion.content) || FORGET_REQUEST.test(lastQuestion.content))
  window.clearTimeout(digestTimers.get(session.id))
  digestTimers.set(
    session.id,
    window.setTimeout(
      () => startDigest(session.id, 'delay'),
      requested ? REQUEST_DELAY : DIGEST_DELAY
    )
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

/** 立即处理所有等待中的整理：离开会话、切换窗口时调用 */
export const flushDigests = (trigger: 'leave' | 'manual' = 'leave') => {
  for (const sessionId of [...digestTimers.keys()]) {
    startDigest(sessionId, trigger)
  }
}

/** 一次整理之后，因为删除而需要清理的摘要：删掉的条目出现过的对话，没有出处时涉及所有对话 */
const unscrubFor = (removed: MemoryItem[], sessionId: string, at: number) =>
  removed.map((item) => ({
    text: item.text,
    at,
    ...(item.sources.length
      ? { sessionIds: [...new Set([...item.sources.map((source) => source.sessionId), sessionId])] }
      : {}),
  }))

/**
 * 整理一个会话：写备忘，并从新内容里提取对记忆的改动。返回是否成功；失败时保留原话节选，下次再试。
 * 没有新的用户消息（续写、重新生成）时只写备忘。
 */
const digestSession = async (session: Session, trigger: DigestTrigger): Promise<boolean> => {
  const key = memoryApiKey()
  if (!memoryEnabled() || !key || !isDigestible(session)) {
    return false
  }
  const startEpoch = currentEpoch()
  const startedAt = Date.now()
  const locale = useSettings.getState().locale
  const prompts = getPrompts(locale)
  const { profile, items, digests } = getMemory()
  const existing = digests.find((digest) => digest.sessionId === session.id)
  const extract = buildExtractInput({
    session,
    digest: existing,
    items,
    avoid: avoidList(profile, items),
    now: startedAt,
    clearedAt: readClearedAt(),
    locale,
  })
  const base = { kind: 'digest', trigger, sessionId: session.id, title: session.title } as const
  setActivity('digesting')
  try {
    const output = await complete({
      apiKey: key,
      system: extract.hasNew ? prompts.extractSystem : withAvoid(prompts.digestSystem, locale),
      user: extract.hasNew ? extract.input : buildTranscript(session, locale),
    })
    // 期间清空了记忆（包括在其他标签页）、关闭了记忆或替换了历史：结果和记录都丢弃
    if (startEpoch !== currentEpoch() || !memoryEnabled() || readClearedAt() > startedAt) {
      return false
    }
    const parsed = extract.hasNew
      ? parseModelOutput(output)
      : { note: output, ops: [], complete: true }
    const summary = parseDigestOutput(parsed.note ?? '')
    // 没有结束标记说明输出被截断或格式不对：备忘照用，记忆改动一条都不用
    const ops = parsed.complete ? parsed.ops : []
    const now = Date.now()
    const covered = latestMessageAt(session)
    const outcome: { result?: OpResult } = {}
    const committed = await commit({
      sessionId: session.id,
      invalidate: false,
      plan: ({ items: currentItems, profile: currentProfile, digests: currentDigests }) => {
        const previous = currentDigests.find((digest) => digest.sessionId === session.id)
        // 另一个标签页在这期间已经整理过同样的内容
        if (previous && previous.digestedAt >= startedAt && coveredAt(previous) >= covered) {
          return null
        }
        const meta = currentProfile ?? emptyProfile()
        const result = applyOps(ops, {
          mode: 'extract',
          items: currentItems,
          refs: extract.refs,
          forgotten: (meta.forgotten ?? []).map((item) => item.text),
          muted: meta.muted ?? [],
          explicit: extract.explicit,
          source: { sessionId: session.id, title: session.title, at: now },
          now,
          createId,
        })
        outcome.result = result
        const digest: MemoryDigest = {
          sessionId: session.id,
          title: session.title,
          summary,
          excerpt: buildExcerpt(session),
          updatedAt: session.updatedAt,
          digestedAt: now,
          messageCount: visibleCount(session),
          coveredAt: covered,
        }
        const removed = result.forgotten
        return {
          putItems: result.put,
          deleteItems: result.remove,
          digests: [digest],
          // 用户在对话里要求忘掉的：记入删除过的内容，并清理相关对话的摘要（包括刚写的这条）
          profile: removed.length
            ? {
                ...meta,
                forgotten: rememberForgotten(
                  meta.forgotten,
                  removed.map((item) => item.text),
                  now
                ),
                unscrubbed: [
                  ...(meta.unscrubbed ?? []),
                  ...unscrubFor(removed, session.id, now + 1),
                ],
              }
            : undefined,
          log: logEntry({
            ...base,
            durationMs: now - startedAt,
            result: summary || result.log.length ? 'saved' : 'skipped',
            detail: summary,
            ...(result.log.length ? { changes: result.log } : {}),
          }),
        }
      },
    })
    setMemory({ failed: false })
    // 期间又有新回答时保留节选，等下一次整理
    if (!latestSessions.has(session.id)) {
      removePending(session.id)
    }
    const result = outcome.result
    if (!committed || !result) {
      return false
    }
    // 改写或删除了已有的记忆：已打开的会话下一轮就不再带着旧内容
    if (result.changes.some((change) => change.kind === 'updated' || change.kind === 'removed')) {
      invalidateSnapshots()
    }
    if (result.changes.length && extract.anchorId) {
      changeSink?.(session.id, extract.anchorId, result.changes)
    }
    if (result.forgotten.length) {
      scheduleScrub()
    }
    return true
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[memory] digest failed', error)
    setMemory({ failed: true })
    if (startEpoch === currentEpoch()) {
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

/**
 * 后台整理全部记忆：把已有条目和上次整理以来的新摘要交给模型，按它提出的增、改、删、合并更新条目。
 * force 为 false 时按批量、间隔和条数上限判断是否需要；返回是否改动了条目。
 * 多个标签页通过 Web Locks 互斥；整理期间用户改动了记忆则整批作废，以用户的操作为准。
 */
const maybeDream = async (force: boolean): Promise<boolean> => {
  const key = memoryApiKey()
  if (!memoryEnabled() || !key) {
    return false
  }
  const run = async (): Promise<boolean> => {
    await reload()
    const { profile, digests, items } = getMemory()
    const dreamedAt = profile?.dreamedAt ?? 0
    const fresh = digests.filter(
      (digest) =>
        digest.summary &&
        digest.digestedAt > dreamedAt &&
        !isHeld(profile, digest.sessionId, digest.digestedAt)
    )
    const saved = items.filter((item) => item.status === 'saved')
    const now = Date.now()
    // 从没整理过时，从第一条新摘要开始计时，不必一有摘要就整理
    const since = dreamedAt || Math.min(now, ...fresh.map((digest) => digest.digestedAt))
    const trigger: MemoryLogEntry['trigger'] | null = force
      ? fresh.length || saved.length
        ? 'manual'
        : null
      : fresh.length >= DREAM_BATCH
        ? 'batch'
        : fresh.length && now - since > DREAM_INTERVAL
          ? 'interval'
          : items.length >= ITEM_LIMIT && items.some((item) => item.updatedAt > dreamedAt)
            ? 'full'
            : null
    if (!trigger) {
      return false
    }
    const startEpoch = currentEpoch()
    const startUpdatedAt = profile?.updatedAt ?? 0
    const locale = useSettings.getState().locale
    const { input, refs } = buildConsolidateInput({
      items,
      digests: fresh,
      avoid: avoidList(profile, items),
      now,
      locale,
    })
    const base = {
      kind: 'profile',
      trigger,
      sources: fresh.map((digest) => digest.title),
      detail: '',
    } as const
    setActivity('dreaming')
    try {
      const output = await complete({
        apiKey: key,
        system: getPrompts(locale).consolidateSystem,
        user: input,
      })
      if (startEpoch !== currentEpoch() || !memoryEnabled() || readClearedAt() > now) {
        return false
      }
      const parsed = parseModelOutput(output)
      const finished = Date.now()
      const durationMs = finished - now
      const outcome: { changed: boolean } = { changed: false }
      await commit({
        invalidate: false,
        plan: ({ items: currentItems, profile: currentProfile }) => {
          const meta = currentProfile ?? emptyProfile()
          // 整理期间用户改动了记忆：以用户的操作为准，下次再整理
          if (meta.updatedAt !== startUpdatedAt) {
            return {
              log: logEntry({ ...base, durationMs, result: 'discarded', reason: 'edited' }),
            }
          }
          // 这些摘要已经看过了：输出无效或改动异常时也不再反复整理同一批
          const stamped: MemoryProfile = { ...meta, dreamedAt: finished }
          if (!parsed.complete) {
            return {
              profile: stamped,
              log: logEntry({ ...base, durationMs, result: 'discarded', reason: 'emptyOutput' }),
            }
          }
          const result = applyOps(parsed.ops, {
            mode: 'consolidate',
            items: currentItems,
            refs,
            forgotten: (meta.forgotten ?? []).map((item) => item.text),
            muted: meta.muted ?? [],
            explicit: false,
            source: null,
            now: finished,
            createId,
          })
          if (result.unsafe) {
            return {
              profile: stamped,
              log: logEntry({
                ...base,
                durationMs,
                result: 'discarded',
                reason: 'unsafe',
                changes: result.log,
              }),
            }
          }
          outcome.changed = result.log.length > 0
          return {
            putItems: result.put,
            deleteItems: result.remove,
            profile: stamped,
            log: logEntry({
              ...base,
              durationMs,
              result: result.log.length ? 'saved' : 'skipped',
              ...(result.log.length ? { changes: result.log } : {}),
            }),
          }
        },
      })
      setMemory({ failed: false })
      return outcome.changed
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[memory] consolidation failed', error)
      setMemory({ failed: true })
      if (startEpoch === currentEpoch()) {
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

/** 为最近的若干会话补整理缺失或落后的摘要，返回新整理的条数 */
const backfill = async (limit: number, trigger: 'catchUp' | 'manual'): Promise<number> => {
  const clearedAt = readClearedAt()
  // 临时对话先排除，再取最近几个，否则几个临时对话就能占满名额
  const summaries = (await db.loadSessionSummaries())
    .filter((summary) => summary.updatedAt > clearedAt && !summary.temporary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
  let count = 0
  for (const summary of summaries) {
    if (!memoryEnabled() || !memoryApiKey()) {
      break
    }
    const existing = getMemory().digests.find((digest) => digest.sessionId === summary.id)
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
  const startEpoch = currentEpoch()
  const updated: MemoryDigest[] = []
  for (const digest of getMemory().digests) {
    if (digest.summary && digest.excerpt === undefined) {
      const session = await db.loadSession(digest.sessionId)
      updated.push({ ...digest, excerpt: session ? buildExcerpt(session) : '' })
    }
  }
  if (!updated.length || startEpoch !== currentEpoch()) {
    return
  }
  await Promise.all(updated.map((digest) => db.saveMemoryDigest(digest)))
  await reload()
  invalidateSnapshots()
}

/** 启动时补上关闭页面前没来得及整理的会话，并按需后台整理 */
const catchUp = () =>
  enqueue(async () => {
    if (!memoryEnabled()) {
      return
    }
    await backfillExcerpts()
    if (!memoryApiKey()) {
      return
    }
    // 上次没能清理完的摘要（当时记忆关闭、没有 API Key 或请求失败）
    await scrubDigests().catch(report('scrub memory digests'))
    await backfill(CATCH_UP_LIMIT, 'catchUp')
    await maybeDream(false)
  }).catch(report('memory catch-up'))

export type OrganizeResult = { digested: number; profileUpdated: boolean }

/** 手动「立即整理」：补齐最近会话的摘要并强制后台整理 */
export const organizeMemory = (): Promise<OrganizeResult> => {
  flushDigests('manual')
  return enqueue(async () => {
    const digested = await backfill(ORGANIZE_LIMIT, 'manual')
    const profileUpdated = await maybeDream(true)
    if (getMemory().failed) {
      throw new Error('Memory organization failed')
    }
    return { digested, profileUpdated }
  })
}

/** 在串行队列里清理摘要；删除、别再提、撤销之后调用 */
export const scheduleScrub = () => {
  void enqueue(scrubDigests).catch(report('scrub memory digests'))
}

/** 清理完成后把条目移出待清理列表；不动 updatedAt，这不是用户对记忆的改动 */
const markScrubbed = (target: { text: string; at: number }, digests: MemoryDigest[] = []) =>
  commit({
    invalidate: true,
    plan: ({ profile, digests: current }) => {
      if (!profile) {
        return null
      }
      const unscrubbed = (profile.unscrubbed ?? []).filter(
        (item) => !(item.text === target.text && item.at === target.at)
      )
      return {
        profile: { ...profile, unscrubbed: unscrubbed.length ? unscrubbed : undefined },
        // 期间重新生成过的摘要已经避开了这件事，以新的为准
        digests: digests.filter((digest) =>
          current.some(
            (item) => item.sessionId === digest.sessionId && item.digestedAt === digest.digestedAt
          )
        ),
      }
    },
  })

/**
 * 逐条处理还没清理的内容：把相关摘要里的这件事删掉。
 * 记忆关闭或没有 API Key 时什么都不做，条目留在待清理列表里；请求失败同样保留，下次再试。
 * 需在串行队列里调用。
 */
const scrubDigests = async () => {
  const key = memoryApiKey()
  if (!memoryEnabled() || !key) {
    return
  }
  const startEpoch = currentEpoch()
  const prompts = getPrompts(useSettings.getState().locale)
  const flat = (summary: string) => summary.replace(/\s+/g, ' ').trim()
  for (const item of getMemory().profile?.unscrubbed ?? []) {
    // 这之后生成的摘要已经避开了这件事，不用再处理
    const targets = getMemory().digests.filter(
      (digest) =>
        digest.summary &&
        digest.digestedAt < item.at &&
        (!item.sessionIds || item.sessionIds.includes(digest.sessionId))
    )
    if (!targets.length) {
      await markScrubbed(item)
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
      if (startEpoch !== currentEpoch()) {
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
      await markScrubbed(item, changed)
    } finally {
      setActivity('idle')
    }
  }
}

/** 删除一条近期对话摘要；对话本身保留，也不会再为同样的内容重新生成。 */
export const forgetDigest = async (sessionId: string): Promise<void> => {
  const existing = getMemory().digests.find((digest) => digest.sessionId === sessionId)
  if (!existing) {
    return
  }
  // 保留一条空摘要作为「已处理」标记，否则下次启动会被补生成回来
  await db.saveMemoryDigest({ ...existing, summary: '' })
  // 活动记录里有这条摘要的原文，一并删除
  await db.deleteMemoryLogForSession(sessionId)
  removePending(sessionId)
  await reload()
  invalidateSnapshots()
  channel?.postMessage('changed')
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
  setMemory((state) => ({
    digests: state.digests.filter((digest) => digest.sessionId !== sessionId),
    log: state.log.filter((entry) => entry.sessionId !== sessionId),
  }))
  invalidateSnapshots()
  channel?.postMessage('changed')
}

const resetVolatile = () => {
  bumpEpoch()
  for (const timer of digestTimers.values()) {
    window.clearTimeout(timer)
  }
  digestTimers.clear()
  latestSessions.clear()
  invalidateSnapshots()
}

/** 历史被全部删除后：近期摘要随会话一起清空，记忆条目保留 */
export const onHistoryReplaced = () => {
  resetVolatile()
  setMemory({ digests: [], pending: {}, log: [] })
  channel?.postMessage('changed')
}

/** 清空全部记忆（条目、摘要、不再提及、活动记录）；对话不受影响 */
export const clearMemory = async (): Promise<void> => {
  resetVolatile()
  await db.clearMemory()
  writeClearedAt(Date.now())
  setMemory({ profile: null, items: [], digests: [], pending: {}, failed: false, log: [] })
  channel?.postMessage('changed')
}

/** 开关变化：关闭时取消待处理的整理；重新开启后补上最近的会话 */
export const onMemoryToggled = () => {
  invalidateSnapshots()
  if (memoryEnabled()) {
    void catchUp()
  } else {
    for (const timer of digestTimers.values()) {
      window.clearTimeout(timer)
    }
    digestTimers.clear()
    latestSessions.clear()
    setMemory({ pending: {} })
  }
}
