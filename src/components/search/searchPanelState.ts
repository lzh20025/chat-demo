import { create } from 'zustand'
import type { MemoryChat } from '../../services/chat/types.js'
import type { Source } from '../../services/chat/view.js'
import {
  countMemoryItems,
  parseMemoryBlock,
  pickUsedMemory,
  type MemoryTrace,
} from '../../services/memory/text.js'

/** 一条回答用到的记忆；trace 为 null 表示记忆块解析不出条目，只能显示原文 */
export type UsedMemory = { trace: MemoryTrace | null; raw: string }

/**
 * 由回答上保存的记忆块、用户原话和模型报出的编号，得到这条回答实际用到的记忆。
 * 没有记忆，或一条都没用到时返回 null。
 */
export const resolveMemory = (
  block: string | undefined,
  chats: MemoryChat[] | undefined,
  used: string[] | undefined
): UsedMemory | null => {
  if (!block) {
    return null
  }
  const parsed = parseMemoryBlock(block, chats)
  if (!parsed) {
    return { trace: null, raw: block }
  }
  const trace = pickUsedMemory(parsed, used)
  return countMemoryItems(trace) ? { trace, raw: block } : null
}

/**
 * 右侧面板。两种用法共用一个位置：
 * - 某次搜索步骤的结果（只有网页）；
 * - 某条回答的来源合集（搜索到的网页 + 用到的记忆）。
 * 同一入口再次点击收起，换入口时替换内容。
 */
type SearchPanelState = {
  /** 打开面板的入口，用于判断再次点击是否收起 */
  entry: string | null
  kind: 'search' | 'references'
  sources: Source[]
  memory: UsedMemory | null
}

const closed: SearchPanelState = { entry: null, kind: 'search', sources: [], memory: null }

export const useSearchPanel = create<SearchPanelState>(() => closed)

export const toggleSearchPanel = (entry: string, sources: Source[]) =>
  useSearchPanel.setState((state) =>
    state.entry === entry ? closed : { ...closed, entry, sources }
  )

export const toggleReferencePanel = (entry: string, sources: Source[], memory: UsedMemory | null) =>
  useSearchPanel.setState((state) =>
    state.entry === entry ? closed : { entry, kind: 'references', sources, memory }
  )

export const closeSearchPanel = () => useSearchPanel.setState(closed)
