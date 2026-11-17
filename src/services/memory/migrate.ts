import type { MemoryCategory, MemoryItem } from '../chat/types.js'
import { parseCategory, sameText } from './ops.js'

/**
 * 旧版的用户档案是一整篇 Markdown，迁移成逐条记忆：按 `##` 小节归类，每行一条。
 * 每行的文本取法与旧版「按原文找到那一行」一致（去掉缩进和列表符号），
 * 这样旧回答的来源面板仍能按原文找到对应的条目。迁移不截断、不受条数上限限制。
 */
export const migrateProfile = ({
  content,
  userEdited,
  now,
  createId,
}: {
  content: string
  /** 用户手改过或从没自动整理过：整篇视为用户确认过的内容 */
  userEdited: boolean
  now: number
  createId: () => string
}): MemoryItem[] => {
  const items: MemoryItem[] = []
  let category: MemoryCategory = 'other'
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      category = parseCategory(heading[1])
      continue
    }
    const text = line.replace(/^[-*]\s+/, '').trim()
    if (!text || items.some((item) => sameText(item.text, text))) {
      continue
    }
    items.push({
      id: createId(),
      text,
      category,
      origin: userEdited ? 'user' : 'auto',
      status: 'saved',
      sources: [],
      // 保持原来的顺序
      createdAt: now + items.length,
      updatedAt: now + items.length,
    })
  }
  return items
}
