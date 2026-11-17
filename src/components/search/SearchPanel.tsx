import type { ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { InstructionsItem, MemoryItems, MemoryRaw } from '../messages/MemoryTrace.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeSearchPanel, countUsedMemory, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

const Section = ({
  title,
  count,
  action,
  children,
}: {
  title: string
  count: number | null
  action?: ReactNode
  children: ReactNode
}) => (
  <section className={styles.section}>
    <div className={styles.sectionHeader}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {count === null ? null : <span className={styles.sectionCount}>· {count}</span>}
      {action}
    </div>
    {children}
  </section>
)

/**
 * 右侧面板：某次搜索的结果，或某条回答的来源合集。
 * 来源合集按「记忆」「网页」分节放在同一个列表里，没有内容的一节不显示；
 * 记忆只列回答实际用到的条目。
 */
export const SearchPanel = () => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const kind = useSearchPanel((state) => state.kind)
  const sources = useSearchPanel((state) => state.sources)
  const memory = useSearchPanel((state) => state.memory)
  if (!entry) {
    return null
  }
  const cards = sources.map((source) => (
    <SourceCard key={source.url} source={source} className={styles.item} />
  ))
  return (
    <aside className={styles.panel}>
      <div className={styles.header}>
        <div role="heading" className={styles.title}>
          {t(kind === 'references' ? 'references' : 'searchResult')}
        </div>
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeSearchPanel}
        />
      </div>
      {/* 换入口时重新挂载，滚动位置回到顶部 */}
      <div key={entry} className={styles.content}>
        {kind === 'search' ? (
          cards
        ) : (
          <>
            {memory ? (
              <Section
                title={t('memory')}
                count={countUsedMemory(memory)}
                action={
                  <button
                    type="button"
                    className={styles.sectionAction}
                    onClick={() => openSettings('memory')}
                  >
                    {t('memoryTraceManage')}
                  </button>
                }
              >
                {memory.trace ? (
                  <MemoryItems trace={memory.trace} />
                ) : memory.raw ? (
                  <MemoryRaw memory={memory.raw} />
                ) : null}
                {memory.instructions ? <InstructionsItem text={memory.instructions} /> : null}
              </Section>
            ) : null}
            {sources.length ? (
              <Section title={t('referenceWeb')} count={sources.length}>
                {cards}
              </Section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  )
}
