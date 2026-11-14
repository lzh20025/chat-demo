import { getVisibleMessages } from '../chat/branches.js'
import type { MemoryDigest, MemoryProfile } from '../chat/db.js'
import { getReplyText } from '../chat/reply.js'
import type { MemoryChat, Message, Session } from '../chat/types.js'
import type { Locale } from '../settings.js'
import { getPrompts, SKIP_MARK } from './prompts.js'

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
export const PROFILE_OUTPUT_LIMIT = 6000

export const clip = (text: string, max: number): string => {
  const normalized = text.trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

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

/** 值得摘要的会话：当前分支上至少有一条用户消息和一条完成的回答 */
export const isDigestible = (session: Session): boolean => {
  const messages = getVisibleMessages(session)
  return (
    messages.some((message) => message.role === 'user' && message.content.trim() !== '') &&
    messages.some(answered)
  )
}

export const visibleCount = (session: Session): number => getVisibleMessages(session).length

/** 摘要是否已覆盖会话当前分支的全部内容 */
export const isDigestFresh = (digest: MemoryDigest | undefined, session: Session): boolean =>
  digest !== undefined && digest.messageCount === visibleCount(session)

/**
 * 供摘要使用的对话文本。超出预算时保留最早的一条用户消息（通常说明了来意）和最近的内容。
 */
export const buildTranscript = (session: Session, locale: Locale): string => {
  const prompts = getPrompts(locale)
  const lines: string[] = []
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      const content = message.content.trim()
      const files = message.files.map((file) => `[${file.name}]`).join(' ')
      const text = [files, clip(content, USER_TURN_BUDGET)].filter(Boolean).join(' ')
      if (text) {
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
  for (let i = rest.length - 1; i >= 0 && used + rest[i].length <= TRANSCRIPT_BUDGET; i -= 1) {
    kept.unshift(rest[i])
    used += rest[i].length
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

/** 解析摘要输出；SKIP 或空输出记为空摘要，表示已处理但没有可记的内容 */
export const parseDigestOutput = (output: string): string => {
  const text = output.trim()
  if (!text || text.replace(/[\s.。!！]/g, '').toUpperCase() === SKIP_MARK) {
    return ''
  }
  return clip(text, DIGEST_OUTPUT_LIMIT)
}

/** 去掉模型偶尔包在外面的 Markdown 代码围栏 */
export const parseProfileOutput = (output: string): string => {
  const fenced = output.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return clip(fenced ? fenced[1] : output, PROFILE_OUTPUT_LIMIT)
}

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
  // 「不再提及」的清理还没跑完时，在那之前生成的摘要可能还带着这件事，先不注入
  const heldBefore = Math.max(0, ...(profile?.unscrubbed ?? []).map((item) => item.at))
  for (const digest of digests) {
    if (digest.summary && digest.digestedAt >= heldBefore) {
      entries.set(digest.sessionId, {
        sessionId: digest.sessionId,
        title: digest.title,
        text: clip(oneLine(digest.summary), SUMMARY_BUDGET),
        excerpt: digest.excerpt ?? '',
        updatedAt: digest.updatedAt,
      })
    }
  }
  // 原话节选是未经处理的用户原文，没法保证不含「不再提及」的事：
  // 清单不为空时不注入原话，等摘要生成（生成时会避开清单里的事）
  for (const item of profile?.muted?.length ? [] : pending) {
    // 待处理的会话有比摘要更新的内容：原话节选排在已有摘要之后一并给出
    if (!item.excerpt) {
      continue
    }
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

/**
 * 注入 system 的记忆块：档案 + 近期对话（不含当前会话）。没有任何内容时 block 为空字符串。
 * chats 与记忆块里的近期对话一一对应，带用户原话节选，供来源面板展示。
 */
export const renderMemoryBlock = ({
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
}): { block: string; chats: MemoryChat[] } => {
  const prompts = getPrompts(locale)
  const recent = selectRecent({ profile, digests, pending, currentSessionId, locale })
  const sections: string[] = []
  // 每条记忆一个编号，模型在回答末尾按编号报出实际用到的条目
  let count = 0
  const nextId = () => `[m${(count += 1)}]`
  const profileText = profile?.content.trim()
  if (profileText) {
    const lines = clip(profileText, PROFILE_BUDGET)
      .split('\n')
      .map((line) => {
        if (!line.trim() || /^\s*#{1,6}\s/.test(line)) {
          return line
        }
        const bullet = line.match(/^(\s*[-*]\s+)(.*)$/)
        return bullet ? `${bullet[1]}${nextId()} ${bullet[2]}` : `${nextId()} ${line}`
      })
    sections.push(`${prompts.profileHeading}\n${lines.join('\n')}`)
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
    return { block: '', chats: [] }
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
  }
}

/** 整理档案时发给模型的 user 消息 */
export const buildDreamInput = ({
  profile,
  digests,
  now,
  locale,
}: {
  profile: MemoryProfile | null
  digests: MemoryDigest[]
  now: number
  locale: Locale
}): string => {
  const prompts = getPrompts(locale)
  const current = profile?.content.trim()
  const edited = profile !== null && profile.updatedAt > profile.dreamedAt && Boolean(current)
  return [
    `${prompts.dreamToday}: ${formatTime(now)}`,
    `${prompts.dreamCurrentProfile}:\n${current ? clip(current, PROFILE_OUTPUT_LIMIT) : prompts.dreamEmptyProfile}`,
    ...(edited ? [prompts.dreamUserEdited] : []),
    ...(profile?.muted?.length
      ? [`${prompts.dreamMuted}:\n${profile.muted.map((item) => `- ${oneLine(item)}`).join('\n')}`]
      : []),
    [
      `${prompts.dreamNewDigests}:`,
      ...[...digests]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map(
          (digest) =>
            `- ${formatTime(digest.updatedAt)} "${oneLine(digest.title) || prompts.untitled}": ${oneLine(digest.summary)}`
        ),
    ].join('\n'),
  ].join('\n\n')
}

/** 记忆块拆回结构化内容，供界面展示某条回答参考的记忆 */
export type MemoryTrace = {
  /** 条目是否带编号；没有编号的旧记忆块无法归因，只能整体展示 */
  numbered: boolean
  /** 档案按 Markdown 小节分组；小节标题之前的内容归入 heading 为 null 的组 */
  profile: { heading: string | null; items: { id: string | null; text: string }[] }[]
  recent: {
    id: string | null
    time: string
    title: string
    text: string
    /** 用户原话；回答上没有保存时缺省，界面退回显示摘要 */
    chat?: MemoryChat
  }[]
}

const TRACE_LOCALES: Locale[] = ['zh-CN', 'en-US']
const ITEM_ID = /^\[(m\d+)\]\s+/
const RECENT_LINE = /^- (?:\[(m\d+)\] )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) "(.*?)": (.*)$/

/**
 * `renderMemoryBlock` 的逆操作。记忆块按生成时的语言保存，两种语言的标题都认；
 * 找不到任何一节（格式已变或内容损坏）时返回 null，由调用方退回显示原文。
 * chats 是随回答保存的用户原话，与近期对话一一对应时挂到各条上。
 */
export const parseMemoryBlock = (block: string, chats: MemoryChat[] = []): MemoryTrace | null => {
  const lines = block
    .replace(/^<memory>\n?/, '')
    .replace(/\n?<\/memory>\s*$/, '')
    .split('\n')
  const prompts = TRACE_LOCALES.map(getPrompts)
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
      group.items.push({ id: text.match(ITEM_ID)?.[1] ?? null, text: text.replace(ITEM_ID, '') })
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
