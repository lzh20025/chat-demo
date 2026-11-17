import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { MemoryItem } from '../../services/chat/types.js'
import { editItem, findItem, findItemByText, muteItem } from '../../services/memory/items.js'
import { sameText } from '../../services/memory/ops.js'
import { forgetDigest, useMemory } from '../../services/memory/store.js'
import { formatTime, type MemoryTrace } from '../../services/memory/text.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconChatOutline16,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconInfoOutline16,
  IconMemoryOutline16,
  IconSettingsOutline16,
} from '../base/icons.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './MemoryTrace.module.css'

const Item = ({
  icon,
  label,
  title,
  detail,
  note,
  dimmed,
  options,
}: {
  icon: ReactNode
  label: string
  title: string
  detail?: string
  /** 操作结果或来源说明，显示在条目下方 */
  note?: string | null
  /** 已处理（不再提及、不再参考）的条目变淡，不再提供操作 */
  dimmed?: boolean
  options?: MenuOption[]
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.item, dimmed && styles.dimmed)}>
      <div className={styles.label}>
        {icon}
        <span>{label}</span>
      </div>
      <div className={styles.title}>{title}</div>
      {detail ? <div className={styles.detail}>{detail}</div> : null}
      {note ? <div className={styles.note}>{note}</div> : null}
      {options?.length && !dimmed ? (
        <Menu options={options}>
          {({ open, toggle }) => (
            <IconButton
              className={clsx(styles.more, open && styles.moreOpen)}
              icon={<IconEllipsisOutline16 />}
              aria-label={t('memoryTraceMore')}
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        </Menu>
      ) : null}
    </div>
  )
}

const failed = () => showToast({ key: 'memorySaveFailed', type: 'error' })

/** 条目从哪来：出处对话（标题 + 时间）、用户自己加的或确认过的、早期整理留下的 */
const describeOrigin = (
  item: MemoryItem | undefined,
  t: ReturnType<typeof useTranslate>
): string => {
  if (!item) {
    return t('memoryTraceGone')
  }
  if (item.sources.length) {
    return t('memoryTraceOriginChats', {
      sources: item.sources
        .map((source) =>
          t('memoryTraceOriginSource', {
            title: source.title || t('memoryUntitled'),
            time: formatTime(source.at),
          })
        )
        .join(t('memoryListSeparator')),
    })
  }
  return t(item.origin === 'user' ? 'memoryTraceOriginUser' : 'memoryTraceOriginEarly')
}

/**
 * 记忆里的一条，多半是模型归纳出来的，可能不对：提供更正、别再提，以及这条从哪来。
 * 面板标题展示回答当时用到的内容；操作作用于现在的条目——有条目 id 时按 id 找（被合并也能找到），
 * 较早的回答没有 id，按原文找。现在的内容与当时不同、或已不在记忆里时，在下方注明。
 */
const ProfileItem = ({ text, itemId }: { text: string; itemId?: string }) => {
  const t = useTranslate()
  const ready = useMemory((state) => state.ready)
  const item = useMemory((state) =>
    itemId ? findItem(state.items, itemId) : findItemByText(state.items, text)
  )
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const current = item?.text ?? text

  const missing = () => {
    showToast({ key: 'memoryTraceMissing' })
    openSettings('memory')
  }

  const correct = async () => {
    const next = draft?.trim()
    if (!next) {
      return
    }
    // 编辑期间条目可能在别处被删掉
    if (!item) {
      setDraft(null)
      missing()
      return
    }
    try {
      if (await editItem(item.id, next)) {
        setNote(t('memoryTraceCorrectedNote'))
        showToast({ key: 'memoryTraceCorrected' })
      } else if (findItem(useMemory.getState().items, item.id)) {
        // 条目还在却没保存：内容为空或像密码、密钥
        failed()
        return
      } else {
        missing()
      }
      setDraft(null)
    } catch {
      failed()
    }
  }

  const mute = async () => {
    try {
      await muteItem({ id: item?.id, text: current })
      setMuted(true)
      setNote(t('memoryTraceMutedNote'))
      showToast({ key: 'memoryTraceMuted' })
    } catch {
      failed()
    }
  }

  // 现在的内容与回答当时不同（更正过、被整理改写过），或已经不在记忆里
  const detail = muted
    ? undefined
    : item
      ? sameText(item.text, text)
        ? undefined
        : t('memoryTraceNow', { text: item.text })
      : ready
        ? t('memoryTraceGone')
        : undefined

  return (
    <>
      <Item
        icon={<IconMemoryOutline16 />}
        label={t('memory')}
        title={text}
        detail={detail}
        note={note}
        dimmed={muted}
        options={[
          {
            key: 'correct',
            label: t('memoryTraceCorrect'),
            icon: <IconEditOutline16 />,
            // 已经不在记忆里的没法更正，直接带去设置
            onSelect: () => (item ? setDraft(item.text) : missing()),
          },
          {
            key: 'mute',
            label: t('memoryTraceMute'),
            icon: <IconCloseOutline16 />,
            onSelect: () => void mute(),
          },
          {
            key: 'origin',
            label: t('memoryTraceOrigin'),
            icon: <IconInfoOutline16 />,
            onSelect: () => setNote(describeOrigin(item, t)),
          },
        ]}
      />
      {draft !== null ? (
        <Modal
          title={t('memoryTraceCorrectTitle')}
          className={styles.correctModal}
          onClose={() => setDraft(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDraft(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={!draft.trim() || draft.trim() === current}
                onClick={() => void correct()}
              >
                {t('memorySave')}
              </Button>
            </>
          }
        >
          <textarea
            className={styles.editor}
            aria-label={t('memoryTraceCorrectTitle')}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
        </Modal>
      ) : null}
    </>
  )
}

/**
 * 一段过往对话，是客观发生过的事，没有对错可改：只提供「不再参考」。
 * 显示用户原话而不是模型看到的摘要；没有记录原话的旧数据退回到摘要。
 */
const ChatItem = ({ item }: { item: MemoryTrace['recent'][number] }) => {
  const t = useTranslate()
  const [forgotten, setForgotten] = useState(false)
  const sessionId = item.chat?.sessionId

  const forget = async (id: string) => {
    try {
      await forgetDigest(id)
      setForgotten(true)
      showToast({ key: 'memoryTraceChatForgotten' })
    } catch {
      failed()
    }
  }

  return (
    <Item
      icon={<IconChatOutline16 />}
      label={t('memoryTracePastChat')}
      title={item.chat?.title || item.title || t('memoryUntitled')}
      detail={[
        item.chat ? formatTime(item.chat.updatedAt) : item.time,
        item.chat?.excerpt || item.text,
      ]
        .filter(Boolean)
        .join(' — ')}
      note={forgotten ? t('memoryTraceChatForgottenNote') : null}
      dimmed={forgotten}
      options={
        sessionId
          ? [
              {
                key: 'forget',
                label: t('memoryTraceForgetChat'),
                icon: <IconCloseOutline16 />,
                onSelect: () => void forget(sessionId),
              },
            ]
          : undefined
      }
    />
  )
}

/** 来源面板里的「记忆」条目：档案逐条列出，过往对话各占一条 */
export const MemoryItems = ({ trace }: { trace: MemoryTrace }) => (
  <>
    {trace.profile.flatMap((group, groupIndex) =>
      group.items.map((item, index) => (
        <ProfileItem
          key={item.id ?? `${groupIndex}-${index}`}
          text={item.text}
          itemId={item.itemId}
        />
      ))
    )}
    {trace.recent.map((item, index) => (
      <ChatItem key={item.id ?? `recent-${index}`} item={item} />
    ))}
  </>
)

/** 自定义指令是用户自己写的，没有对错可改，只提供去设置里编辑的入口 */
export const InstructionsItem = ({ text }: { text: string }) => {
  const t = useTranslate()
  return (
    <Item
      icon={<IconSettingsOutline16 />}
      label={t('customInstructions')}
      title={text}
      options={[
        {
          key: 'edit',
          label: t('memoryEdit'),
          icon: <IconEditOutline16 />,
          onSelect: () => openSettings('general'),
        },
      ]}
    />
  )
}

/** 记忆块无法拆成条目时（格式已变或内容损坏）退回显示原文 */
export const MemoryRaw = ({ memory }: { memory: string }) => (
  <pre className={styles.raw}>{memory}</pre>
)
