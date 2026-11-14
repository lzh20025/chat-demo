import { getVisibleMessages } from '../chat/branches.js'
import type { MemoryDigest, MemoryProfile } from '../chat/db.js'
import { getReplyText } from '../chat/reply.js'
import type { Message, Session } from '../chat/types.js'
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

/**
 * 拼出注入 system 的记忆块。当前会话不出现在近期对话里；
 * 有摘要的会话用摘要，摘要落后或尚未生成的用原话节选。没有任何内容时返回空字符串。
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
}): string => {
  const prompts = getPrompts(locale)
  const entries = new Map<string, { title: string; text: string; updatedAt: number }>()
  for (const digest of digests) {
    if (digest.summary) {
      entries.set(digest.sessionId, {
        title: digest.title,
        text: clip(oneLine(digest.summary), SUMMARY_BUDGET),
        updatedAt: digest.updatedAt,
      })
    }
  }
  for (const item of pending) {
    // 待处理的会话有比摘要更新的内容：原话节选排在已有摘要之后一并给出
    if (!item.excerpt) {
      continue
    }
    const previous = entries.get(item.sessionId)
    const raw = `${prompts.rawLabel}: ${item.excerpt}`
    entries.set(item.sessionId, {
      title: item.title,
      text: previous ? `${previous.text} ${raw}` : raw,
      updatedAt: item.updatedAt,
    })
  }
  if (currentSessionId !== null) {
    entries.delete(currentSessionId)
  }
  const recent = [...entries.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT)
  const sections: string[] = []
  const profileText = profile?.content.trim()
  if (profileText) {
    sections.push(`${prompts.profileHeading}\n${clip(profileText, PROFILE_BUDGET)}`)
  }
  if (recent.length) {
    sections.push(
      [
        prompts.recentHeading,
        ...recent.map(
          (item) =>
            `- ${formatTime(item.updatedAt)} "${oneLine(item.title) || prompts.untitled}": ${item.text}`
        ),
      ].join('\n')
    )
  }
  if (!sections.length) {
    return ''
  }
  return `<memory>\n${prompts.injectHeader}\n\n${sections.join('\n\n')}\n</memory>`
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
