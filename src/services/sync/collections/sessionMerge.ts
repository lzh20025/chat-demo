import { normalizeSession } from '../../chat/branches.js'
import type {
  AssistantMessage,
  MemoryChange,
  Message,
  Session,
  UserMessage,
} from '../../chat/types.js'

/**
 * 会话的消息级合并：两台设备都改过同一个会话时，按消息 id 取并集，谁的内容都不丢。
 * 消息是一棵带 parentId 的分支树，两边各自新增的提问和回答挂在各自的父节点下，自然成为并列的版本。
 * 标题、当前显示哪条分支这类只能有一个值的字段，取最近改动的一方。纯函数。
 */

/** 回答的完成程度：完成的优先于被停止或出错的，再优先于没生成完的 */
const replyRank = (message: AssistantMessage) =>
  message.status === 'done' ? 2 : message.status === 'stopped' || message.status === 'error' ? 1 : 0

const changeKey = (change: MemoryChange) =>
  change.kind === 'full' ? `full:${change.text}` : `${change.kind}:${change.itemId}`

const mergeMemoryChanges = (primary: UserMessage, secondary: UserMessage): UserMessage => {
  const existing = new Set((primary.memoryChanges ?? []).map(changeKey))
  const extra = (secondary.memoryChanges ?? []).filter((change) => !existing.has(changeKey(change)))
  return extra.length
    ? { ...primary, memoryChanges: [...(primary.memoryChanges ?? []), ...extra] }
    : primary
}

/** 两边都有的同一条消息：primary 来自最近改动的一方 */
const mergeMessage = (primary: Message, secondary: Message): Message => {
  let content: Message = primary
  if (primary.role === 'user' && secondary.role === 'user') {
    content = mergeMemoryChanges(primary, secondary)
  } else if (
    primary.role === 'assistant' &&
    secondary.role === 'assistant' &&
    replyRank(secondary) > replyRank(primary)
  ) {
    content = secondary
  }
  // 分支选择跟最近改动的一方；它那边这条消息后面还没有内容时，沿用另一方的，新内容才看得到
  const selectedChildId = primary.selectedChildId ?? secondary.selectedChildId
  return { ...content, parentId: primary.parentId, selectedChildId }
}

export const mergeSessions = (
  local: Session,
  remote: Session,
  times: { localModifiedAt: number; remoteModifiedAt: number }
): Session => {
  const remoteIsNewer = times.remoteModifiedAt > times.localModifiedAt
  const primary = normalizeSession(remoteIsNewer ? remote : local)
  const secondary = normalizeSession(remoteIsNewer ? local : remote)
  const secondaryById = new Map(secondary.messages.map((message) => [message.id, message]))
  const primaryIds = new Set(primary.messages.map((message) => message.id))

  const messages = [
    ...primary.messages.map((message) => {
      const other = secondaryById.get(message.id)
      return other ? mergeMessage(message, other) : message
    }),
    // 只有另一方有的消息排在后面：同一个父节点下，它们是靠后的版本
    ...secondary.messages.filter((message) => !primaryIds.has(message.id)),
  ]

  // 选中的下一条必须真的是自己的子节点，否则退回到第一个子节点
  const byId = new Map(messages.map((message) => [message.id, message]))
  const firstChild = new Map<string, string>()
  for (const message of messages) {
    if (message.parentId && !firstChild.has(message.parentId)) {
      firstChild.set(message.parentId, message.id)
    }
  }
  const repaired = messages.map((message): Message => {
    const selected = message.selectedChildId ? byId.get(message.selectedChildId) : undefined
    const selectedChildId =
      selected?.parentId === message.id ? selected.id : firstChild.get(message.id)
    return selectedChildId === message.selectedChildId ? message : { ...message, selectedChildId }
  })

  const root = (session: Session) =>
    session.rootMessageId && byId.has(session.rootMessageId) ? session.rootMessageId : null
  return {
    id: primary.id,
    title: primary.title,
    createdAt: Math.min(primary.createdAt, secondary.createdAt),
    updatedAt: Math.max(primary.updatedAt, secondary.updatedAt),
    messages: repaired,
    rootMessageId:
      root(primary) ?? root(secondary) ?? repaired.find((m) => !m.parentId)?.id ?? null,
  }
}
