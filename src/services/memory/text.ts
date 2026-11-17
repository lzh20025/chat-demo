import { getVisibleMessages } from '../chat/branches.js'
import type { MemoryDigest, MemoryProfile } from '../chat/db.js'
import { getReplyText } from '../chat/reply.js'
import {
  MEMORY_CATEGORIES,
  type MemoryChat,
  type MemoryItem,
  type Message,
  type Session,
} from '../chat/types.js'
import type { Locale } from '../settings.js'
import { REMEMBER_REQUEST } from './ops.js'
import { ALL_PROMPTS, getPrompts, SKIP_MARK } from './prompts.js'

/** 注入 system 的近期对话条数上限 */
export const RECENT_LIMIT = 12
/** 各部分的字符预算：记忆块每轮都会带上，需要有明确上限 */
const PROFILE_BUDGET = 4000
const SUMMARY_BUDGET = 400
const TRANSCRIPT_BUDGET = 8000
const USER_TURN_BUDGET = 1200
const ASSISTANT_TURN_BUDGET = 500
const EXCERPT_TURNS = 4
const EXCERPT_TURN_BUDGET = 160
/** 模型输出的硬上限，防止异常输出撑大每轮请求 */
export const DIGEST_OUTPUT_LIMIT = 600

export const clip = (text: string, max: number): string => {
  const normalized = text.trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const pad = (value: number) => String(value).padStart(2, '0')

/** 本地时区的「年-月-日 时:分」，让模型能判断对话距今多久 */
export const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 尚未生成摘要时的即时替代：一条待处理会话的用户原话节选 */
export type PendingExcerpt = {
  sessionId: string
  title: string
  excerpt: string
  updatedAt: number
}

const answered = (message: Message) =>
  message.role === 'assistant' && message.status === 'done' && getReplyText(message).trim() !== ''

/** 值得整理的会话：不是临时对话，当前分支上至少有一条用户消息和一条完成的回答 */
export const isDigestible = (session: Session): boolean => {
  if (session.temporary) {
    return false
  }
  const messages = getVisibleMessages(session)
  return (
    messages.some((message) => message.role === 'user' && message.content.trim() !== '') &&
    messages.some(answered) &&
    // 含其他服务商回答的对话不归纳：归纳走 DeepSeek，不应把这些对话发过去
    !messages.some((message) => message.role === 'assistant' && message.provider)
  )
}

export const visibleCount = (session: Session): number => getVisibleMessages(session).length

/** 当前分支上最后一条消息的创建时间 */
export const latestMessageAt = (session: Session): number =>
  Math.max(0, ...getVisibleMessages(session).map((message) => message.createdAt))

/** 摘要已覆盖到的时间；旧摘要没有记录，用当时会话的更新时间代替 */
export const coveredAt = (digest: MemoryDigest): number => digest.coveredAt ?? digest.updatedAt

/** 摘要是否已覆盖会话当前分支的全部内容 */
export const isDigestFresh = (digest: MemoryDigest | undefined, session: Session): boolean =>
  digest !== undefined && coveredAt(digest) >= latestMessageAt(session)

/**
 * 摘要是否要先扣下：别再提、删除、撤销之后，相关对话的摘要还没清理完时，里面可能还带着这件事。
 * 清理条目没有指定对话时涉及所有对话。
 */
export const isHeld = (profile: MemoryProfile | null, sessionId: string, digestedAt: number) =>
  (profile?.unscrubbed ?? []).some(
    (item) => digestedAt < item.at && (!item.sessionIds || item.sessionIds.includes(sessionId))
  )

/**
 * 供整理使用的对话文本。超出预算时保留最早的一条用户消息（通常说明了来意）和最近的内容。
 * 给了 newSince 时，在这之后的第一条用户消息前插入分隔线，标出「新内容」；
 * 新内容本身超出预算时，分隔线放在保留部分的开头。
 */
export const buildTranscript = (session: Session, locale: Locale, newSince?: number): string => {
  const prompts = getPrompts(locale)
  const lines: string[] = []
  let divider = -1
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      const content = message.content.trim()
      const files = message.files.map((file) => `[${file.name}]`).join(' ')
      const text = [files, clip(content, USER_TURN_BUDGET)].filter(Boolean).join(' ')
      if (text) {
        if (newSince !== undefined && divider === -1 && message.createdAt > newSince) {
          divider = lines.length
          lines.push(prompts.newDivider)
        }
        lines.push(`${prompts.userLabel}: ${text}`)
      }
    } else if (answered(message)) {
      lines.push(`${prompts.assistantLabel}: ${clip(getReplyText(message), ASSISTANT_TURN_BUDGET)}`)
    }
  }
  const total = lines.reduce((sum, line) => sum + line.length, 0)
  if (total <= TRANSCRIPT_BUDGET) {
    return lines.join('\n\n')
  }
  const [first, ...rest] = lines
  const kept: string[] = []
  let used = first.length
  let start = lines.length
  for (let i = rest.length - 1; i >= 0 && used + rest[i].length <= TRANSCRIPT_BUDGET; i -= 1) {
    kept.unshift(rest[i])
    used += rest[i].length
    start = i + 1
  }
  if (divider > 0 && divider < start) {
    kept.unshift(prompts.newDivider)
  }
  return [first, '…', ...kept].join('\n\n')
}

/** 最近几条用户消息的节选，摘要生成前先用它让新会话知道刚才聊了什么 */
export const buildExcerpt = (session: Session): string =>
  getVisibleMessages(session)
    .filter((message) => message.role === 'user' && message.content.trim() !== '')
    .slice(-EXCERPT_TURNS)
    .map((message) => clip(oneLine((message as { content: string }).content), EXCERPT_TURN_BUDGET))
    .join(' / ')

/** 解析备忘；SKIP 或空输出记为空摘要，表示已处理但没有可记的内容 */
export const parseDigestOutput = (output: string): string => {
  const text = output.trim()
  if (!text || text.replace(/[\s.。!！]/g, '').toUpperCase() === SKIP_MARK) {
    return ''
  }
  return clip(text, DIGEST_OUTPUT_LIMIT)
}

/** 已生效的条目按分类、创建顺序排列：记忆块、提取和整理都用这个顺序 */
export const orderItems = (items: MemoryItem[]): MemoryItem[] =>
  items
    .filter((item) => item.status === 'saved')
    .sort(
      (a, b) =>
        MEMORY_CATEGORIES.indexOf(a.category) - MEMORY_CATEGORIES.indexOf(b.category) ||
        a.createdAt - b.createdAt
    )

type RecentEntry = {
  sessionId: string
  title: string
  text: string
  excerpt: string
  updatedAt: number
}

/**
 * 注入记忆块的近期对话（由新到旧）：有摘要的会话用摘要，摘要落后或尚未生成的补上原话节选。
 * excerpt 是用户原话，不进入记忆块，只供界面展示。
 */
const selectRecent = ({
  profile,
  digests,
  pending,
  currentSessionId,
  locale,
}: {
  profile: MemoryProfile | null
  digests: MemoryDigest[]
  pending: PendingExcerpt[]
  currentSessionId: string | null
  locale: Locale
}): RecentEntry[] => {
  const prompts = getPrompts(locale)
  const entries = new Map<string, RecentEntry>()
  for (const digest of digests) {
    if (digest.summary && !isHeld(profile, digest.sessionId, digest.digestedAt)) {
      entries.set(digest.sessionId, {
        sessionId: digest.sessionId,
        title: digest.title,
        text: clip(oneLine(digest.summary), SUMMARY_BUDGET),
        excerpt: digest.excerpt ?? '',
        updatedAt: digest.updatedAt,
      })
    }
  }
  // 原话节选是未经处理的用户原文，没法保证不含「不再提及」或刚删掉的事：
  // 清单不为空、或这个对话还有没清理完的内容时不注入原话，等摘要生成（生成时会避开这些事）
  for (const item of profile?.muted?.length ? [] : pending) {
    if (!item.excerpt || isHeld(profile, item.sessionId, Number.NEGATIVE_INFINITY)) {
      continue
    }
    // 待处理的会话有比摘要更新的内容：原话节选排在已有摘要之后一并给出
    const previous = entries.get(item.sessionId)
    const raw = `${prompts.rawLabel}: ${item.excerpt}`
    entries.set(item.sessionId, {
      sessionId: item.sessionId,
      title: item.title,
      text: previous ? `${previous.text} ${raw}` : raw,
      excerpt: item.excerpt,
      updatedAt: item.updatedAt,
    })
  }
  if (currentSessionId !== null) {
    entries.delete(currentSessionId)
  }
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT)
}

/** 记忆块放得下的条目：用户确认过的优先，其余按更新时间由新到旧，整条取舍 */
const fitItems = (items: MemoryItem[]): Set<string> => {
  const ranked = [...items].sort(
    (a, b) => Number(b.origin === 'user') - Number(a.origin === 'user') || b.updatedAt - a.updatedAt
  )
  const kept = new Set<string>()
  let used = 0
  for (const item of ranked) {
    used += item.text.length + 8
    if (used > PROFILE_BUDGET) {
      break
    }
    kept.add(item.id)
  }
  return kept
}

export type MemorySnapshot = {
  block: string
  /** 与记忆块里的近期对话一一对应，带用户原话节选，供来源面板展示 */
  chats: MemoryChat[]
  /** 记忆块里的编号对应的条目 id */
  ids: Record<string, string>
}

/**
 * 注入 system 的记忆块：已生效的条目按分类分节 + 近期对话（不含当前会话）。没有任何内容时 block 为空字符串。
 * 小节标题和 `- [mN] 内容` 的行格式与旧版档案一致，parseMemoryBlock 对新旧记忆块通用。
 */
export const renderMemoryBlock = ({
  profile,
  items,
  digests,
  pending,
  currentSessionId,
  locale,
}: {
  profile: MemoryProfile | null
  items: MemoryItem[]
  digests: MemoryDigest[]
  pending: PendingExcerpt[]
  currentSessionId: string | null
  locale: Locale
}): MemorySnapshot => {
  const prompts = getPrompts(locale)
  const recent = selectRecent({ profile, digests, pending, currentSessionId, locale })
  const sections: string[] = []
  const ids: Record<string, string> = {}
  // 每条记忆一个编号，模型在回答末尾按编号报出实际用到的条目
  let count = 0
  const nextId = (itemId?: string) => {
    count += 1
    if (itemId) {
      ids[`m${count}`] = itemId
    }
    return `[m${count}]`
  }
  const saved = orderItems(items)
  const kept = fitItems(saved)
  const groups = MEMORY_CATEGORIES.map((category) => ({
    category,
    items: saved.filter((item) => item.category === category && kept.has(item.id)),
  })).filter((group) => group.items.length)
  if (groups.length) {
    sections.push(
      [
        prompts.profileHeading,
        ...groups.flatMap((group) => [
          `## ${prompts.categories[group.category]}`,
          ...group.items.map((item) => `- ${nextId(item.id)} ${oneLine(item.text)}`),
        ]),
      ].join('\n')
    )
  }
  if (recent.length) {
    sections.push(
      [
        prompts.recentHeading,
        ...recent.map(
          (item) =>
            `- ${nextId()} ${formatTime(item.updatedAt)} "${oneLine(item.title) || prompts.untitled}": ${item.text}`
        ),
      ].join('\n')
    )
  }
  if (!sections.length) {
    return { block: '', chats: [], ids: {} }
  }
  const muted = profile?.muted ?? []
  if (muted.length) {
    sections.push(
      [prompts.mutedHeading, prompts.mutedIntro, ...muted.map((item) => `- ${oneLine(item)}`)].join(
        '\n'
      )
    )
  }
  // 归因要求放在最后，离回答最近，模型更容易照做
  sections.push(prompts.injectAttribution)
  return {
    block: `<memory>\n${prompts.injectHeader}\n\n${sections.join('\n\n')}\n</memory>`,
    chats: recent.map(({ sessionId, title, updatedAt, excerpt }) => ({
      sessionId,
      title,
      updatedAt,
      excerpt,
    })),
    ids,
  }
}

/** 发给模型的条目编号：refs[n - 1] 对应 kn，带当时的 updatedAt，落库时据此判断条目是否被改过 */
export type ItemRefs = { id: string; updatedAt: number }[]

const listItems = (items: MemoryItem[], locale: Locale, markUser: boolean) => {
  const prompts = getPrompts(locale)
  const ordered = orderItems(items)
  return {
    refs: ordered.map(({ id, updatedAt }) => ({ id, updatedAt })),
    text: ordered.length
      ? ordered
          .map(
            (item, index) =>
              `k${index + 1} [${prompts.categories[item.category]}] ${oneLine(item.text)}${
                markUser && item.origin === 'user' ? ` ${prompts.userConfirmed}` : ''
              }`
          )
          .join('\n')
      : prompts.itemsEmpty,
  }
}

const avoidSection = (avoid: string[], locale: Locale) =>
  avoid.length
    ? [`${getPrompts(locale).avoidLabel}:\n${avoid.map((text) => `- ${oneLine(text)}`).join('\n')}`]
    : []

/**
 * 回答后提取时发给模型的 user 消息：已记住的事（带编号）、不要再记录的事、标出新内容的对话。
 * 新内容是摘要覆盖之后、且晚于上次清空记忆的用户消息；没有新内容时只写备忘，不提取。
 */
export const buildExtractInput = ({
  session,
  digest,
  items,
  avoid,
  now,
  clearedAt,
  locale,
}: {
  session: Session
  digest: MemoryDigest | undefined
  items: MemoryItem[]
  avoid: string[]
  now: number
  clearedAt: number
  locale: Locale
}) => {
  const prompts = getPrompts(locale)
  const since = Math.max(digest ? coveredAt(digest) : 0, clearedAt)
  const fresh = getVisibleMessages(session).filter(
    (message): message is Extract<Message, { role: 'user' }> =>
      message.role === 'user' && message.createdAt > since && message.content.trim() !== ''
  )
  const { refs, text } = listItems(items, locale, false)
  return {
    input: [
      `${prompts.today}: ${formatTime(now)}`,
      `${prompts.itemsLabel}:\n${text}`,
      ...avoidSection(avoid, locale),
      `${prompts.transcriptLabel}:\n${buildTranscript(session, locale, since)}`,
    ].join('\n\n'),
    refs,
    hasNew: fresh.length > 0,
    explicit: fresh.some((message) => REMEMBER_REQUEST.test(message.content)),
    /** 改动挂到这条提问上，显示在它下方的回答里 */
    anchorId: fresh.at(-1)?.id ?? null,
  }
}

/** 后台整理时发给模型的 user 消息 */
export const buildConsolidateInput = ({
  items,
  digests,
  avoid,
  now,
  locale,
}: {
  items: MemoryItem[]
  digests: MemoryDigest[]
  avoid: string[]
  now: number
  locale: Locale
}) => {
  const prompts = getPrompts(locale)
  const { refs, text } = listItems(items, locale, true)
  return {
    input: [
      `${prompts.today}: ${formatTime(now)}`,
      `${prompts.itemsLabel}:\n${text}`,
      ...avoidSection(avoid, locale),
      [
        `${prompts.newDigestsLabel}:`,
        ...(digests.length
          ? [...digests]
              .sort((a, b) => a.updatedAt - b.updatedAt)
              .map(
                (digest) =>
                  `- ${formatTime(digest.updatedAt)} "${oneLine(digest.title) || prompts.untitled}": ${oneLine(digest.summary)}`
              )
          : [prompts.itemsEmpty]),
      ].join('\n'),
    ].join('\n\n'),
    refs,
  }
}

/** 记忆块拆回结构化内容，供界面展示某条回答参考的记忆 */
export type MemoryTrace = {
  /** 条目是否带编号；没有编号的旧记忆块无法归因，只能整体展示 */
  numbered: boolean
  /** 档案按 Markdown 小节分组；小节标题之前的内容归入 heading 为 null 的组 */
  profile: {
    heading: string | null
    items: { id: string | null; text: string; itemId?: string }[]
  }[]
  recent: {
    id: string | null
    time: string
    title: string
    text: string
    /** 用户原话；回答上没有保存时缺省，界面退回显示摘要 */
    chat?: MemoryChat
  }[]
}

const ITEM_ID = /^\[(m\d+)\]\s+/
const RECENT_LINE = /^- (?:\[(m\d+)\] )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) "(.*?)": (.*)$/

/**
 * `renderMemoryBlock` 的逆操作。记忆块按生成时的语言保存，两种语言的标题都认；
 * 找不到任何一节（格式已变或内容损坏）时返回 null，由调用方退回显示原文。
 * chats 是随回答保存的用户原话，与近期对话一一对应时挂到各条上；ids 是编号对应的条目 id。
 */
export const parseMemoryBlock = (
  block: string,
  chats: MemoryChat[] = [],
  ids: Record<string, string> = {}
): MemoryTrace | null => {
  const lines = block
    .replace(/^<memory>\n?/, '')
    .replace(/\n?<\/memory>\s*$/, '')
    .split('\n')
  const prompts = ALL_PROMPTS
  const profileAt = lines.findIndex((line) => prompts.some((p) => p.profileHeading === line))
  // 档案正文可由用户编辑，可能出现同名标题：近期对话总在最后一节，取最后一次出现
  const recentAt = lines.findLastIndex((line) => prompts.some((p) => p.recentHeading === line))
  if (profileAt === -1 && recentAt === -1) {
    return null
  }
  const profile: MemoryTrace['profile'] = []
  if (profileAt !== -1) {
    // 档案之后可能是近期对话、不要提及或输出格式说明，到最近的一节为止
    const next = lines.findIndex(
      (line, index) =>
        index > profileAt &&
        (index === recentAt ||
          prompts.some(
            (p) => p.mutedHeading === line || p.injectAttribution.startsWith(`${line}\n`)
          ))
    )
    const end = next === -1 ? lines.length : next
    for (const raw of lines.slice(profileAt + 1, end)) {
      const line = raw.trim()
      if (!line) {
        continue
      }
      const heading = line.match(/^#{1,6}\s+(.*)$/)
      if (heading) {
        profile.push({ heading: heading[1], items: [] })
        continue
      }
      let group = profile.at(-1)
      if (!group) {
        group = { heading: null, items: [] }
        profile.push(group)
      }
      const text = line.replace(/^[-*]\s+/, '')
      const id = text.match(ITEM_ID)?.[1] ?? null
      const itemId = id ? ids[id] : undefined
      group.items.push({ id, text: text.replace(ITEM_ID, ''), ...(itemId ? { itemId } : {}) })
    }
  }
  const recent: MemoryTrace['recent'] = []
  if (recentAt !== -1) {
    for (const line of lines.slice(recentAt + 1)) {
      // 之后是不要提及的清单或输出格式说明，不属于记忆
      if (line.startsWith('# ')) {
        break
      }
      if (!line.trim()) {
        continue
      }
      const match = line.match(RECENT_LINE)
      recent.push(
        match
          ? { id: match[1] ?? null, time: match[2], title: match[3], text: match[4] }
          : { id: null, time: '', title: '', text: line.replace(/^-\s+/, '') }
      )
    }
  }
  if (chats.length === recent.length) {
    recent.forEach((item, index) => {
      item.chat = chats[index]
    })
  }
  const groups = profile.filter((group) => group.items.length)
  return {
    numbered:
      groups.some((group) => group.items.some((item) => item.id)) || recent.some((item) => item.id),
    profile: groups,
    recent,
  }
}

/**
 * 只留下回答实际用到的记忆。used 是模型在回答末尾报出的编号；
 * 带编号的记忆块没有收到报告（回答被中断或模型没照做）时视为没有用到。
 * 没有编号的旧记忆块无法归因，原样返回。
 */
export const pickUsedMemory = (trace: MemoryTrace, used: string[] | undefined): MemoryTrace => {
  if (!trace.numbered) {
    return trace
  }
  const ids = new Set(used)
  return {
    numbered: true,
    profile: trace.profile
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.id !== null && ids.has(item.id)),
      }))
      .filter((group) => group.items.length),
    recent: trace.recent.filter((item) => item.id !== null && ids.has(item.id)),
  }
}

export const countMemoryItems = (trace: MemoryTrace): number =>
  trace.profile.reduce((sum, group) => sum + group.items.length, 0) + trace.recent.length
