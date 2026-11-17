import clsx from 'clsx'
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { MemoryLogEntry } from '../../services/chat/db.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryItem,
} from '../../services/chat/types.js'
import {
  addItem,
  confirmItem,
  dismissItem,
  editItem,
  forgetItem,
  muteItem,
  unmuteItem,
} from '../../services/memory/items.js'
import {
  cleanItemText,
  isCredentialLike,
  ITEM_LIMIT,
  ITEM_TEXT_LIMIT,
  sameText,
} from '../../services/memory/ops.js'
import {
  clearMemory,
  forgetDigest,
  onMemoryToggled,
  organizeMemory,
  useMemory,
} from '../../services/memory/store.js'
import { formatTime, orderItems, renderMemoryBlock } from '../../services/memory/text.js'
import { finishMemoryIntro, setMemoryEnabled, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Disclosure } from '../base/Disclosure.js'
import {
  IconChatOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import memoryStyles from './MemorySetting.module.css'
import { closeSettings } from './settingsDialogState.js'
import styles from './Settings.module.css'
import textBoxStyles from './TextBox.module.css'

/**
 * 设置 →「记忆」，按需逐层展开：
 * - 默认只有开关、需要处理的提示、待确认的条目和「我记得的事」；
 * - 点开条目看它来自哪次对话；「最近聊过的话题」「不再提及」默认收起；
 * - 「高级」里是整理状态、整理记录、发给模型的原文和清空。
 * 模型看到的记忆全部能在这里找到，没有隐藏的部分。
 */
export const MemorySetting = () => {
  const [clearing, setClearing] = useState(false)
  // 打开过记忆设置，对话里的首次说明就不必再出现
  useEffect(finishMemoryIntro, [])
  return (
    <>
      <SwitchCell />
      <PendingCell />
      <ItemsCell />
      <TopicsCell />
      <MutedCell />
      <AdvancedCell onClear={() => setClearing(true)} />
      {clearing ? <ClearConfirm onClose={() => setClearing(false)} /> : null}
    </>
  )
}

/** 执行一个记忆操作，成功时可给出提示，失败时统一提示重试 */
const attempt = async (run: () => Promise<unknown>, success?: TranslationKey) => {
  try {
    await run()
    if (success) {
      showToast({ key: success })
    }
  } catch {
    showToast({ key: 'memorySaveFailed', type: 'error' })
  }
}

const CATEGORY_LABELS: Record<MemoryCategory, TranslationKey> = {
  basics: 'memoryPageCategoryBasics',
  ongoing: 'memoryPageCategoryOngoing',
  preferences: 'memoryPageCategoryPreferences',
  people: 'memoryPageCategoryPeople',
  other: 'memoryPageCategoryOther',
}

/** 开关、一句话说明（可展开「了解更多」），以及整理失败、记忆已满时的提示 */
const SwitchCell = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const failed = useMemory((state) => state.failed)
  const full = useMemory((state) => state.items.length >= ITEM_LIMIT)
  const [about, setAbout] = useState(false)
  const aboutId = useId()
  // 整理失败只在开启时有意义；记忆已满时「添加」不可用，关闭时也要说明原因
  const alerts: TranslationKey[] = [
    ...(enabled && failed ? ['memoryStatusFailed' as const] : []),
    ...(full ? ['memoryPageFull' as const] : []),
  ]
  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memory')}</div>
          <div className={styles.description}>
            {t('memoryPageIntro')}{' '}
            <button
              type="button"
              className={memoryStyles.learnMore}
              aria-expanded={about}
              aria-controls={about ? aboutId : undefined}
              onClick={() => setAbout((value) => !value)}
            >
              {t('memoryPageLearnMore')}
              {about ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </button>
          </div>
        </div>
        <Switch
          checked={enabled}
          ariaLabel={t('memory')}
          onChange={(value) => {
            setMemoryEnabled(value)
            onMemoryToggled()
          }}
        />
      </div>
      {about ? (
        <ul id={aboutId} className={memoryStyles.about}>
          <li>{t('memoryPageAboutWhat')}</li>
          <li>{t('memoryPageAboutUse')}</li>
          <li>{t('memoryPageAboutWhere')}</li>
        </ul>
      ) : null}
      {alerts.map((key) => (
        <div key={key} className={memoryStyles.alert} role="status">
          <IconWarningOutline16 />
          <span>{t(key)}</span>
        </div>
      ))}
    </div>
  )
}

/** 敏感内容先问再记：有待确认的条目时才出现 */
const PendingCell = () => {
  const t = useTranslate()
  const items = useMemory((state) => state.items)
  const pending = useMemo(
    () =>
      items.filter((item) => item.status === 'pending').sort((a, b) => a.createdAt - b.createdAt),
    [items]
  )
  if (!pending.length) {
    return null
  }
  return (
    <div className={styles.cell}>
      <div className={styles.text}>
        <div className={styles.label}>{t('memoryPagePendingTitle')}</div>
        <div className={styles.description}>{t('memoryPagePendingHint')}</div>
      </div>
      <ul className={memoryStyles.list}>
        {pending.map((item) => (
          <li key={item.id} className={memoryStyles.pending}>
            <span className={memoryStyles.pendingText}>{item.text}</span>
            <span className={memoryStyles.pendingActions}>
              <Button
                size="s"
                className={memoryStyles.smallButton}
                aria-label={`${t('memoryPageRemember')}: ${item.text}`}
                onClick={() => void attempt(() => confirmItem(item.id))}
              >
                {t('memoryPageRemember')}
              </Button>
              <Button
                variant="outlined"
                size="s"
                className={memoryStyles.smallButton}
                aria-label={`${t('memoryPageDismiss')}: ${item.text}`}
                onClick={() => void attempt(() => dismissItem(item.id))}
              >
                {t('memoryPageDismiss')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 默认只显示前几条，其余收在「显示全部」后面 */
const PREVIEW_COUNT = 6

/** 「我记得的事」：已生效的条目按分类分组，组内按记下的先后排列 */
const ItemsCell = () => {
  const t = useTranslate()
  const ready = useMemory((state) => state.ready)
  const items = useMemory((state) => state.items)
  const saved = useMemo(() => orderItems(items), [items])
  const full = items.length >= ITEM_LIMIT
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<MemoryItem | 'new' | null>(null)
  const visible = showAll ? saved : saved.slice(0, PREVIEW_COUNT)
  const groups = MEMORY_CATEGORIES.map((category) => ({
    category,
    items: visible.filter((item) => item.category === category),
  })).filter((group) => group.items.length)

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>
            {t('memoryPageItemsTitle')}
            {saved.length ? <span className={memoryStyles.count}> · {saved.length}</span> : null}
          </div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={!ready || (full && !items.some((item) => item.status === 'pending'))}
          onClick={() => setEditing('new')}
        >
          {t('memoryPageAdd')}
        </Button>
      </div>
      {!ready ? null : saved.length ? (
        <>
          {groups.map((group) => (
            <section key={group.category} className={memoryStyles.group}>
              <h3 className={memoryStyles.groupTitle}>{t(CATEGORY_LABELS[group.category])}</h3>
              <ul className={memoryStyles.items}>
                {group.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    expanded={expanded === item.id}
                    onToggle={() => setExpanded((value) => (value === item.id ? null : item.id))}
                    onEdit={() => setEditing(item)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {saved.length > PREVIEW_COUNT ? (
            <button
              type="button"
              className={clsx(memoryStyles.showAll, showAll && memoryStyles.showAllOpen)}
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? t('memoryPageShowLess') : t('memoryPageShowAll', { count: saved.length })}
              <IconChevronDownOutline14 />
            </button>
          ) : null}
        </>
      ) : (
        <div className={clsx(textBoxStyles.box, textBoxStyles.empty)}>
          {t('memoryPageItemsEmpty')}
        </div>
      )}
      {editing ? (
        <ItemEditor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  )
}

const ItemRow = ({
  item,
  expanded,
  onToggle,
  onEdit,
}: {
  item: MemoryItem
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
}) => {
  const t = useTranslate()
  const detailId = useId()
  const options: MenuOption[] = [
    { key: 'edit', label: t('memoryEdit'), icon: <IconEditOutline16 />, onSelect: onEdit },
    {
      key: 'mute',
      label: t('memoryPageMute'),
      icon: <IconCloseOutline16 />,
      onSelect: () =>
        void attempt(() => muteItem({ id: item.id, text: item.text }), 'memoryPageMuted'),
    },
    {
      key: 'delete',
      label: t('delete'),
      icon: <IconTrashOutline16 />,
      danger: true,
      onSelect: () => void attempt(() => forgetItem(item.id), 'memoryPageDeleted'),
    },
  ]
  return (
    <li className={clsx(memoryStyles.item, expanded && memoryStyles.itemExpanded)}>
      <div className={memoryStyles.itemRow}>
        <button
          type="button"
          className={memoryStyles.itemText}
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          onClick={onToggle}
        >
          {item.text}
        </button>
        <Menu options={options}>
          {({ open, toggle }) => (
            <IconButton
              size="m"
              icon={<IconEllipsisOutline16 />}
              className={clsx(memoryStyles.itemMenu, open && memoryStyles.itemMenuOpen)}
              aria-label={`${t('memoryPageItemActions')}: ${item.text}`}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        </Menu>
      </div>
      {expanded ? <ItemDetail id={detailId} item={item} /> : null}
    </li>
  )
}

/** 条目详情：来自哪些对话（对话还在才能跳转）、是否由你添加或确认、更新时间 */
const ItemDetail = ({ id, item }: { id: string; item: MemoryItem }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const existing = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions])
  const sources = [...item.sources].sort((a, b) => b.at - a.at)
  return (
    <div id={id} className={memoryStyles.detail}>
      {sources.length ? (
        <div>
          <div>{t('memoryPageFrom')}</div>
          <ul className={memoryStyles.sources}>
            {sources.map((source, index) => {
              const title = source.title || t('memoryUntitled')
              return (
                <li key={`${source.sessionId}-${index}`} className={memoryStyles.source}>
                  {existing.has(source.sessionId) ? (
                    <button
                      type="button"
                      className={memoryStyles.sourceLink}
                      onClick={() => {
                        selectSession(source.sessionId)
                        closeSettings()
                      }}
                    >
                      <IconChatOutline16 />
                      <span>{title}</span>
                    </button>
                  ) : (
                    <span className={memoryStyles.sourceGone}>
                      {title} · {t('memoryPageChatGone')}
                    </span>
                  )}
                  <span className={memoryStyles.sourceTime}>{formatTime(source.at)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : item.origin === 'auto' ? (
        <div>{t('memoryPageFromPast')}</div>
      ) : null}
      {item.origin === 'user' ? <div>{t('memoryPageByUser')}</div> : null}
      <div>{t('memoryPageUpdated', { time: formatTime(item.updatedAt) })}</div>
    </div>
  )
}

/** 不能添加或改成这段文字的原因；服务层只返回成败，这里先判断好给出具体提示 */
const itemProblem = (
  text: string,
  items: MemoryItem[],
  editingId?: string
): TranslationKey | null => {
  const normalized = cleanItemText(text)
  if (isCredentialLike(normalized)) {
    return 'memoryPageSecret'
  }
  if (
    items.some(
      (item) => item.id !== editingId && item.status === 'saved' && sameText(item.text, normalized)
    )
  ) {
    return 'memoryPageDuplicate'
  }
  // 与一条待确认的内容相同时，添加即确认，不占新位置
  if (
    !editingId &&
    items.length >= ITEM_LIMIT &&
    !items.some((item) => sameText(item.text, normalized))
  ) {
    return 'memoryPageFullToast'
  }
  return null
}

/** 添加（item 为 null）或编辑一条：单行文字 + 分类；回车提交 */
const ItemEditor = ({ item, onClose }: { item: MemoryItem | null; onClose: () => void }) => {
  const t = useTranslate()
  const [text, setText] = useState(item?.text ?? '')
  const [category, setCategory] = useState<MemoryCategory>(item?.category ?? 'other')
  const [busy, setBusy] = useState(false)
  const value = text.trim()
  const unchanged = item !== null && item.text === value && item.category === category
  const canSubmit = Boolean(value) && !unchanged && !busy

  const submit = async () => {
    if (!canSubmit) {
      return
    }
    const problem = itemProblem(value, useMemory.getState().items, item?.id)
    if (problem) {
      showToast({ key: problem, type: 'error' })
      return
    }
    setBusy(true)
    try {
      const ok = item ? await editItem(item.id, value, category) : await addItem(value, category)
      if (ok) {
        showToast({ key: item ? 'memorySaved' : 'memoryPageAdded' })
        onClose()
        return
      }
      // 提交期间数据可能被其他标签页或后台整理改动过，按最新数据再判断一次原因
      showToast({
        key:
          itemProblem(value, useMemory.getState().items, item?.id) ??
          (item ? 'memoryPageMissing' : 'memorySaveFailed'),
        type: 'error',
      })
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
    }
    setBusy(false)
  }

  return (
    <Modal
      title={t(item ? 'memoryPageEditTitle' : 'memoryPageAddTitle')}
      className={memoryStyles.editorModal}
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <div className={styles.deleteActions} aria-busy={busy}>
          <Button variant="outlined" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {t(item ? 'memorySave' : 'memoryPageAdd')}
          </Button>
        </div>
      }
    >
      <textarea
        className={clsx(textBoxStyles.editor, memoryStyles.itemEditor)}
        aria-label={t(item ? 'memoryPageEditTitle' : 'memoryPageAddTitle')}
        placeholder={t('memoryPagePlaceholder')}
        maxLength={ITEM_TEXT_LIMIT}
        rows={2}
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // 一条记忆只有一行：回车直接提交，输入法选词时的回车除外
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className={memoryStyles.categoryRow}>
        <span>{t('memoryPageCategory')}</span>
        <Select
          ariaLabel={t('memoryPageCategory')}
          value={category}
          options={MEMORY_CATEGORIES.map((value) => ({
            value,
            label: t(CATEGORY_LABELS[value]),
          }))}
          onChange={setCategory}
        />
      </div>
    </Modal>
  )
}

/** 最近聊过的话题：新对话会参考的对话备忘，可逐条不再参考 */
const TopicsCell = () => {
  const t = useTranslate()
  const digests = useMemory((state) => state.digests)
  const pending = useMemory((state) => state.pending)
  const visible = useMemo(
    () => digests.filter((digest) => digest.summary).sort((a, b) => b.updatedAt - a.updatedAt),
    [digests]
  )
  const waiting = Object.keys(pending).length
  return (
    <div className={styles.cell}>
      <Disclosure title={t('memoryPageTopicsTitle')} count={visible.length}>
        <div className={styles.description}>{t('memoryPageTopicsHint')}</div>
        {waiting ? (
          <div className={clsx(styles.description, memoryStyles.waiting)}>
            {t('memoryPageTopicsWaiting', { count: waiting })}
          </div>
        ) : null}
        {visible.length ? (
          <ul className={memoryStyles.list}>
            {visible.map((digest) => {
              const title = digest.title || t('memoryUntitled')
              return (
                <li key={digest.sessionId} className={memoryStyles.card}>
                  <div className={memoryStyles.cardText}>
                    <div className={memoryStyles.cardTitle}>
                      <span className={memoryStyles.cardName}>{title}</span>
                      <span className={memoryStyles.cardTime}>{formatTime(digest.updatedAt)}</span>
                    </div>
                    <div className={memoryStyles.cardSummary}>{digest.summary}</div>
                  </div>
                  <Button
                    variant="outlined"
                    size="s"
                    className={memoryStyles.smallButton}
                    aria-label={`${t('memoryPageForgetTopic')}: ${title}`}
                    onClick={() => void attempt(() => forgetDigest(digest.sessionId))}
                  >
                    {t('memoryPageForgetTopic')}
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className={clsx(textBoxStyles.box, textBoxStyles.empty)}>
            {t('memoryPageTopicsEmpty')}
          </div>
        )}
      </Disclosure>
    </div>
  )
}

/** 「别再提这件事」攒下的清单；没有时不显示 */
const MutedCell = () => {
  const t = useTranslate()
  const muted = useMemory((state) => state.profile?.muted)
  if (!muted?.length) {
    return null
  }
  return (
    <div className={styles.cell}>
      <Disclosure title={t('memoryMuted')} count={muted.length}>
        <div className={styles.description}>{t('memoryPageMutedHint')}</div>
        <ul className={memoryStyles.list}>
          {muted.map((text) => (
            <li key={text} className={memoryStyles.card}>
              <div className={clsx(memoryStyles.cardText, memoryStyles.cardSummary)}>{text}</div>
              <Button
                variant="outlined"
                size="s"
                className={memoryStyles.smallButton}
                aria-label={`${t('memoryMutedRestore')}: ${text}`}
                onClick={() => void attempt(() => unmuteItem(text))}
              >
                {t('memoryMutedRestore')}
              </Button>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  )
}

/** 高级：整理状态和立即整理、整理记录、发给模型的内容、清空 */
const AdvancedCell = ({ onClear }: { onClear: () => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.cell}>
      <Disclosure title={t('memoryPageAdvanced')}>
        <OrganizeSection />
        <LogSection />
        <PreviewSection />
        <div className={clsx(memoryStyles.section, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{t('memoryClear')}</div>
            <div className={styles.description}>{t('memoryPageClearHint')}</div>
          </div>
          <Button variant="dangerOutlined" size="m" className={styles.cellButton} onClick={onClear}>
            {t('memoryClearAction')}
          </Button>
        </div>
      </Disclosure>
    </div>
  )
}

const OrganizeSection = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const dreamedAt = useMemory((state) => state.profile?.dreamedAt ?? 0)
  const activity = useMemory((state) => state.activity)
  const failed = useMemory((state) => state.failed)
  const [organizing, setOrganizing] = useState(false)
  const busy = organizing || activity !== 'idle'

  const organize = async () => {
    setOrganizing(true)
    try {
      const result = await organizeMemory()
      showToast({
        key:
          result.profileUpdated || result.digested ? 'memoryOrganized' : 'memoryOrganizedNothing',
      })
    } catch {
      showToast({ key: 'memoryOrganizeFailed', type: 'error' })
    } finally {
      setOrganizing(false)
    }
  }

  // 正在做什么 / 为什么不能整理 / 上次整理的时间，逐行给出
  const blocked = !enabled ? t('memoryPageOff') : !hasApiKey ? t('memoryPageNeedsKey') : null
  return (
    <div className={clsx(memoryStyles.section, styles.row)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('memoryPageOrganizeTitle')}</div>
        <div className={styles.description} aria-live="polite">
          {busy ? (
            <div>{t(activity === 'dreaming' ? 'memoryPageBusyAll' : 'memoryPageBusyChats')}</div>
          ) : failed ? (
            <div className={styles.error}>{t('memoryStatusFailed')}</div>
          ) : null}
          {blocked ? <div>{blocked}</div> : null}
          <div>
            {dreamedAt
              ? t('memoryStatusUpdated', { time: formatTime(dreamedAt) })
              : t('memoryStatusNever')}
          </div>
        </div>
      </div>
      <Button
        variant="outlined"
        size="m"
        className={styles.cellButton}
        disabled={busy || Boolean(blocked)}
        onClick={() => void organize()}
      >
        {t('memoryOrganize')}
      </Button>
    </div>
  )
}

const TRIGGER_LABELS: Record<MemoryLogEntry['trigger'], TranslationKey> = {
  delay: 'memoryLogTriggerDelay',
  leave: 'memoryLogTriggerLeave',
  catchUp: 'memoryPageTriggerOpen',
  manual: 'memoryLogTriggerManual',
  first: 'memoryLogTriggerFirst',
  batch: 'memoryPageTriggerChats',
  interval: 'memoryLogTriggerInterval',
  full: 'memoryPageTriggerFull',
}

const RESULT_LABELS: Record<MemoryLogEntry['result'], TranslationKey> = {
  saved: 'memoryLogResultSaved',
  skipped: 'memoryLogResultSkipped',
  discarded: 'memoryLogResultDiscarded',
  failed: 'memoryLogResultFailed',
}

type ChangeKind = NonNullable<MemoryLogEntry['changes']>[number]['kind']

const CHANGE_LABELS: Record<ChangeKind, { mark: string; label: TranslationKey }> = {
  added: { mark: '+', label: 'memoryPageChangeAdded' },
  asked: { mark: '?', label: 'memoryPageChangeAsked' },
  updated: { mark: '~', label: 'memoryPageChangeUpdated' },
  removed: { mark: '−', label: 'memoryPageChangeRemoved' },
  merged: { mark: '⇄', label: 'memoryPageChangeMerged' },
}

/** 整理记录：每次整理的触发原因、结果，以及这次记住、修改、删除了什么 */
const LogSection = () => {
  const t = useTranslate()
  const log = useMemory((state) => state.log)
  return (
    <div className={memoryStyles.section}>
      <Disclosure title={t('memoryPageLogTitle')} count={log.length}>
        <div className={styles.description}>{t('memoryPageLogHint')}</div>
        {log.length ? (
          <ul className={clsx(memoryStyles.list, memoryStyles.log)}>
            {log.map((entry) => (
              <LogItem key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <div className={clsx(textBoxStyles.box, textBoxStyles.empty)}>{t('memoryLogEmpty')}</div>
        )}
      </Disclosure>
    </div>
  )
}

const logNote = (entry: MemoryLogEntry): TranslationKey | null => {
  if (entry.result === 'skipped') {
    return entry.kind === 'digest' ? 'memoryLogSkippedDetail' : 'memoryPageNothingChanged'
  }
  switch (entry.reason) {
    case 'edited':
      return 'memoryPageUserEdited'
    case 'emptyOutput':
      return 'memoryLogEmptyOutputDetail'
    case 'unsafe':
      return 'memoryPageUnsafe'
    default:
      return null
  }
}

const LogItem = ({ entry }: { entry: MemoryLogEntry }) => {
  const t = useTranslate()
  const kind = t(entry.kind === 'digest' ? 'memoryPageLogChat' : 'memoryPageLogAll')
  const note = logNote(entry)
  return (
    <li className={memoryStyles.logItem}>
      <details>
        <summary className={memoryStyles.logSummary}>
          <span className={memoryStyles.logLine}>
            <span className={memoryStyles.cardTime}>{formatTime(entry.at)}</span>
            <span className={memoryStyles.logKind}>{kind}</span>
            {entry.kind === 'digest' ? (
              <span className={memoryStyles.cardName}>{entry.title || t('memoryUntitled')}</span>
            ) : null}
            <span className={clsx(memoryStyles.logResult, memoryStyles[entry.result])}>
              {t(RESULT_LABELS[entry.result])}
            </span>
          </span>
          <span className={memoryStyles.logMeta}>
            {t(TRIGGER_LABELS[entry.trigger])} ·{' '}
            {t('memoryLogDuration', { seconds: (entry.durationMs / 1000).toFixed(1) })}
          </span>
        </summary>
        <div className={memoryStyles.logDetail}>
          {entry.sources?.length ? (
            <div className={memoryStyles.logMeta}>
              {t('memoryPageLogSources', {
                titles: entry.sources.map((title) => title || t('memoryUntitled')).join(' / '),
              })}
            </div>
          ) : null}
          {note ? <div className={memoryStyles.logMeta}>{t(note)}</div> : null}
          {entry.changes?.length ? (
            <ul className={memoryStyles.changes}>
              {entry.changes.map((change, index) => (
                <li key={index} className={memoryStyles.change}>
                  <span
                    className={clsx(memoryStyles.changeMark, memoryStyles[change.kind])}
                    aria-hidden="true"
                  >
                    {CHANGE_LABELS[change.kind].mark}
                  </span>
                  <span className={memoryStyles.changeText}>
                    <span className={memoryStyles.changeLabel}>
                      {t(CHANGE_LABELS[change.kind].label)}
                    </span>{' '}
                    {change.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {entry.detail ? (
            <div
              className={clsx(
                memoryStyles.logText,
                entry.result === 'failed' && memoryStyles.failed
              )}
            >
              {entry.detail}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  )
}

/** 发给模型的内容：新对话开始时注入的记忆原文 */
const PreviewSection = () => {
  const t = useTranslate()
  return (
    <div className={memoryStyles.section}>
      <Disclosure title={t('memoryPagePreviewTitle')}>
        <PreviewBody />
      </Disclosure>
    </div>
  )
}

/** 只在展开时渲染，避免每次记忆变化都重新生成原文 */
const PreviewBody = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const locale = useSettings((state) => state.locale)
  const profile = useMemory((state) => state.profile)
  const items = useMemory((state) => state.items)
  const digests = useMemory((state) => state.digests)
  const pending = useMemory((state) => state.pending)
  const block = useMemo(
    () =>
      renderMemoryBlock({
        profile,
        items,
        digests,
        pending: Object.values(pending),
        currentSessionId: null,
        locale,
      }).block,
    [profile, items, digests, pending, locale]
  )
  if (!enabled) {
    return (
      <div className={clsx(textBoxStyles.box, textBoxStyles.empty)}>
        {t('memoryPagePreviewOff')}
      </div>
    )
  }
  return (
    <>
      <div className={styles.description}>{t('memoryPagePreviewHint')}</div>
      {block ? (
        <pre className={memoryStyles.preview}>{block}</pre>
      ) : (
        <div className={clsx(textBoxStyles.box, textBoxStyles.empty)}>
          {t('memoryPagePreviewEmpty')}
        </div>
      )}
    </>
  )
}

const ClearConfirm = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    setBusy(true)
    try {
      await clearMemory()
      showToast({ key: 'memoryCleared' })
      onClose()
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('memoryPageClearTitle')}
      className={styles.deleteConfirm}
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <div className={styles.deleteActions} aria-busy={busy}>
          <Button variant="outlined" autoFocus disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void confirm()}>
            {t('memoryClearAction')}
          </Button>
        </div>
      }
    >
      {t('memoryClearConfirmDescription')}
    </Modal>
  )
}
