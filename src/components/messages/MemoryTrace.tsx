import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  correctProfileItem,
  findProfileOrigin,
  forgetDigest,
  muteProfileItem,
} from '../../services/memory/store.js'
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

/**
 * 档案里的一条记忆，是模型归纳出来的，可能不对：
 * 提供更正、不再提及，以及这条是哪次整理写进来的。
 * 面板展示的是回答当时的快照，操作作用于当前档案。
 */
const ProfileItem = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [current, setCurrent] = useState(text)
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)

  const correct = async () => {
    const next = draft?.trim()
    if (!next) {
      return
    }
    try {
      if (await correctProfileItem(current, next)) {
        setCurrent(next)
        setNote(t('memoryTraceCorrectedNote'))
        showToast({ key: 'memoryTraceCorrected' })
      } else {
        showToast({ key: 'memoryTraceCorrectMissing' })
        openSettings('memory')
      }
      setDraft(null)
    } catch {
      failed()
    }
  }

  const mute = async () => {
    try {
      await muteProfileItem(current)
      setMuted(true)
      setNote(t('memoryTraceMutedNote'))
      showToast({ key: 'memoryTraceMuted' })
    } catch {
      failed()
    }
  }

  const explain = () => {
    const origin = findProfileOrigin(current)
    setNote(
      origin
        ? t('memoryTraceOriginDream', {
            time: formatTime(origin.at),
            titles: origin.sources.map((title) => title || t('memoryUntitled')).join(' / '),
          })
        : t('memoryTraceOriginUnknown')
    )
  }

  return (
    <>
      <Item
        icon={<IconMemoryOutline16 />}
        label={t('memory')}
        title={current}
        note={note}
        dimmed={muted}
        options={[
          {
            key: 'correct',
            label: t('memoryTraceCorrect'),
            icon: <IconEditOutline16 />,
            onSelect: () => setDraft(current),
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
            onSelect: explain,
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
        <ProfileItem key={item.id ?? `${groupIndex}-${index}`} text={item.text} />
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
