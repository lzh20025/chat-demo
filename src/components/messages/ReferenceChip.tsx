import clsx from 'clsx'
import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import type { Source } from '../../services/chat/view.js'
import { countMemoryItems } from '../../services/memory/text.js'
import { IconButton } from '../base/IconButton.js'
import { IconBrowseOutline16, IconMemoryOutline16 } from '../base/icons.js'
import { resolveMemory, toggleReferencePanel, useSearchPanel } from '../search/searchPanelState.js'
import styles from './ReferenceChip.module.css'

/**
 * 回答操作栏末尾的来源按钮，和复制、朗读、重新生成同一种图标按钮：
 * 悬停提示这条回答搜索到的网页数和实际用到的记忆数，点击在右侧面板展开，再点一次收起。
 * 两者都没有时不显示。
 */
export const ReferenceChip = ({
  message,
  sources,
  className,
}: {
  message: AssistantMessage
  sources: Source[]
  className?: string
}) => {
  const t = useTranslate()
  const entry = `${message.id}-references`
  const active = useSearchPanel((state) => state.entry === entry)
  const memory = useMemo(
    () => resolveMemory(message.memory, message.memoryChats, message.memoryUsed),
    [message.memory, message.memoryChats, message.memoryUsed]
  )
  // 解析不出条目的记忆块按一条算，面板里显示原文
  const memoryCount = memory ? (memory.trace ? countMemoryItems(memory.trace) : 1) : 0
  if (!sources.length && !memory) {
    return null
  }
  const labels = [
    sources.length
      ? t(sources.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries', {
          count: sources.length,
        })
      : null,
    memoryCount
      ? t(memoryCount === 1 ? 'memoryTraceCountOne' : 'memoryTraceCount', { count: memoryCount })
      : null,
  ].filter(Boolean)
  return (
    <IconButton
      className={clsx(active && styles.active, className)}
      icon={sources.length ? <IconBrowseOutline16 /> : <IconMemoryOutline16 />}
      tooltip={`${t('references')}: ${labels.join(' · ')}`}
      tooltipPlacement="bottom"
      aria-expanded={active}
      onClick={() => toggleReferencePanel(entry, sources, memory)}
    />
  )
}
