import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { MemoryChange, MemoryItem } from '../../services/chat/types.js'
import {
  confirmItem,
  dismissItem,
  findItem,
  findItemByText,
  getChangeState,
  isChangeCleared,
  undoChange,
} from '../../services/memory/items.js'
import { sameText } from '../../services/memory/ops.js'
import { useMemory } from '../../services/memory/store.js'
import { claimMemoryIntro, finishMemoryIntro, useSettings } from '../../services/settings.js'
import { IconChevronDownOutline14, IconMemoryOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './MemoryNotice.module.css'

/**
 * 一条改动现在的样子，由改动本身和当前条目推出，不写回消息：
 * 条目之后被撤销、编辑、整理过，提示跟着变。
 */
type Status =
  /** 新增，可撤销 */
  | 'added'
  /** 新增后又被编辑或整理过，只能去设置里管理 */
  | 'addedChanged'
  | 'updated'
  | 'updatedChanged'
  /** 删除，可撤销 */
  | 'removed'
  /** 删除后又放回来了 */
  | 'restored'
  /** 新增或修改已撤销，或条目已被删除 */
  | 'undone'
  /** 待确认的敏感内容 */
  | 'asking'
  | 'confirmed'
  | 'declined'
  | 'full'

type Described = { status: Status; text: string }

const describe = (change: MemoryChange, items: MemoryItem[]): Described => {
  const state = getChangeState(change, items)
  switch (change.kind) {
    case 'full':
      return { status: 'full', text: change.text }
    case 'removed':
      // 撤销时若已有同样内容的条目，不会再放一份，按已恢复显示
      return {
        status:
          state === 'undoable' && !findItemByText(items, change.item.text) ? 'removed' : 'restored',
        text: change.text,
      }
    case 'asked':
      return state === 'pending'
        ? { status: 'asking', text: change.text }
        : state === 'confirmed'
          ? { status: 'confirmed', text: findItem(items, change.itemId)?.text ?? change.text }
          : { status: 'declined', text: change.text }
    case 'added':
    case 'updated': {
      if (state === 'gone') {
        return { status: 'undone', text: change.text }
      }
      if (state === 'undoable') {
        return { status: change.kind, text: change.text }
      }
      const item = findItem(items, change.itemId)
      // 撤销修改会把条目改回原来的内容，同样算已撤销
      if (
        change.kind === 'updated' &&
        item?.id === change.itemId &&
        sameText(item.text, change.previous)
      ) {
        return { status: 'undone', text: change.text }
      }
      return {
        status: change.kind === 'added' ? 'addedChanged' : 'updatedChanged',
        text: item?.text ?? change.text,
      }
    }
  }
}

type Action = 'undo' | 'manage' | 'manageMemory' | 'remember' | 'decline'

const VIEWS: Record<Status, { label: TranslationKey; actions: Action[]; dimmed?: boolean }> = {
  added: { label: 'memoryNoticeAdded', actions: ['undo'] },
  addedChanged: { label: 'memoryNoticeAdded', actions: ['manage'] },
  updated: { label: 'memoryNoticeUpdated', actions: ['undo'] },
  updatedChanged: { label: 'memoryNoticeUpdated', actions: ['manage'] },
  removed: { label: 'memoryNoticeRemoved', actions: ['undo'] },
  restored: { label: 'memoryNoticeRestored', actions: [] },
  undone: { label: 'memoryNoticeUndone', actions: [], dimmed: true },
  asking: { label: 'memoryNoticeAsk', actions: ['remember', 'decline'] },
  confirmed: { label: 'memoryNoticeAdded', actions: [] },
  declined: { label: 'memoryNoticeDeclined', actions: [], dimmed: true },
  full: { label: 'memoryNoticeFull', actions: ['manageMemory'] },
}

const ACTION_LABELS: Record<Action, TranslationKey> = {
  undo: 'memoryNoticeUndo',
  manage: 'memoryNoticeManage',
  manageMemory: 'memoryNoticeManageMemory',
  remember: 'memoryNoticeRemember',
  decline: 'memoryNoticeDecline',
}

/** 打开记忆设置即视为看过首次说明 */
const manageMemory = () => {
  finishMemoryIntro()
  openSettings('memory')
}

/** 折叠时摘要里的计数：按每条改动现在的样子归类，待确认的单独显示，不计入 */
const SUMMARY: { key: TranslationKey; statuses: Status[] }[] = [
  { key: 'memoryNoticeCountAdded', statuses: ['added', 'addedChanged'] },
  { key: 'memoryNoticeCountUpdated', statuses: ['updated', 'updatedChanged'] },
  { key: 'memoryNoticeCountRemoved', statuses: ['removed'] },
  { key: 'memoryNoticeCountFull', statuses: ['full'] },
  { key: 'memoryNoticeCountUndone', statuses: ['undone', 'restored'] },
]

const Row = ({
  change,
  described,
  sessionId,
  icon,
}: {
  change: MemoryChange
  described: Described
  sessionId: string
  /** 第一行带记忆图标，其余行与它的文字对齐 */
  icon: boolean
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const view = VIEWS[described.status]

  const run = async (task: () => Promise<boolean>) => {
    setBusy(true)
    try {
      if (!(await task())) {
        // 条目在别处（设置、另一个标签页、后台整理）已经变了，提示会随最新状态更新
        showToast({ key: 'memoryNoticeStale' })
      }
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const act = (action: Action) => {
    switch (action) {
      case 'undo':
        return void run(() => undoChange(change, sessionId))
      case 'remember':
        return change.kind === 'asked' ? void run(() => confirmItem(change.itemId)) : undefined
      case 'decline':
        return change.kind === 'asked' ? void run(() => dismissItem(change.itemId)) : undefined
      case 'manage':
      case 'manageMemory':
        return manageMemory()
    }
  }

  return (
    <div className={clsx(styles.row, !icon && styles.indent, view.dimmed && styles.dimmed)}>
      {icon ? <IconMemoryOutline16 /> : null}
      <span className={styles.body}>
        <span className={styles.text}>{t(view.label, { text: described.text })}</span>
        {view.actions.map((action) => (
          <button
            key={action}
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => act(action)}
          >
            {t(ACTION_LABELS[action])}
          </button>
        ))}
      </span>
    </div>
  )
}

/**
 * 回答下方的记忆提示：这一轮对话之后记住、修改、忘记了什么，可以就地撤销；
 * 敏感内容在这里问用户要不要记。改动挂在提问上，这里只读，状态由当前记忆条目推出。
 * 多条非询问的改动折叠成一行摘要，展开后逐条处理；待确认的询问始终显示。
 * 第一次出现提示时附一行说明，点「知道了」或打开记忆设置后不再出现。
 */
export const MemoryNotice = ({
  sessionId,
  messageId,
  changes,
}: {
  sessionId: string
  /** 所在回答的 id，首次说明挂在它上面 */
  messageId: string
  changes: MemoryChange[]
}) => {
  const t = useTranslate()
  const ready = useMemory((state) => state.ready)
  const items = useMemory((state) => state.items)
  const intro = useSettings((state) => state.memoryIntro)
  const [expanded, setExpanded] = useState(false)
  // 清空记忆之前的改动不再显示，否则旧对话里都会变成「已撤销」
  const visible = changes.filter((change) => !isChangeCleared(change))

  // 在 effect 里认领首次说明，不在渲染时改设置；已挂到别的回答或已看过时不变
  useEffect(() => {
    if (ready && visible.length) {
      claimMemoryIntro(messageId)
    }
  }, [ready, messageId, visible.length])

  // 条目还没读出来时无法判断状态，先不显示，免得闪一下「已撤销」
  if (!ready) {
    return null
  }

  const rows = visible.map((change, index) => ({
    key: `${index}-${change.kind === 'full' ? 'full' : change.itemId}`,
    change,
    described: describe(change, items),
  }))
  if (!rows.length) {
    return null
  }
  // 是否折叠只看改动的种类，不看当前状态：用户处理完询问后，刚点过的行不会突然收起来
  const asks = rows.filter((row) => row.change.kind === 'asked')
  const others = rows.filter((row) => row.change.kind !== 'asked')
  const collapsible = others.length > 1

  const renderRows = (list: typeof rows, firstIcon: boolean) =>
    list.map((row, index) => (
      <Row
        key={row.key}
        change={row.change}
        described={row.described}
        sessionId={sessionId}
        icon={firstIcon && index === 0}
      />
    ))

  let content
  if (collapsible) {
    const counts = SUMMARY.map(({ key, statuses }) => ({
      key,
      count: others.filter((row) => statuses.includes(row.described.status)).length,
    })).filter(({ count }) => count > 0)
    // 只剩撤销过的改动时不再说「已更新记忆」
    const onlyUndone = counts.length === 1 && counts[0].key === 'memoryNoticeCountUndone'
    content = (
      <>
        <div className={styles.row}>
          <IconMemoryOutline16 />
          <button
            type="button"
            className={styles.summary}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {onlyUndone
              ? t('memoryNoticeSummaryUndone')
              : t('memoryNoticeSummary', {
                  changes: counts
                    .map(({ key, count }) => t(key, { count }))
                    .join(t('memoryListSeparator')),
                })}
            <span className={clsx(styles.chevron, expanded && styles.chevronOpen)}>
              <IconChevronDownOutline14 />
            </span>
          </button>
        </div>
        {expanded ? renderRows(others, false) : null}
        {renderRows(asks, false)}
      </>
    )
  } else {
    content = renderRows([...others, ...asks], true)
  }

  return (
    <div className={styles.notice} aria-live="polite">
      {content}
      {intro === messageId ? (
        <div className={clsx(styles.row, styles.indent, styles.intro)}>
          <span className={styles.body}>
            <span className={styles.text}>{t('memoryNoticeIntro')}</span>
            <button type="button" className={styles.action} onClick={finishMemoryIntro}>
              {t('memoryNoticeIntroDismiss')}
            </button>
            <button type="button" className={styles.action} onClick={manageMemory}>
              {t('memoryNoticeManageMemory')}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  )
}
