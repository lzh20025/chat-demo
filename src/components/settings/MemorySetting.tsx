import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { MemoryLogEntry } from '../../services/chat/db.js'
import {
  clearMemory,
  forgetDigest,
  onMemoryToggled,
  organizeMemory,
  saveProfile,
  unmuteItem,
  useMemory,
} from '../../services/memory/store.js'
import { formatTime } from '../../services/memory/text.js'
import { setMemoryEnabled, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import memoryStyles from './MemorySetting.module.css'
import styles from './Settings.module.css'

/**
 * 设置 →「记忆」：开关、用户档案（查看、编辑、立即整理）、不再提及的清单、近期对话摘要（逐条删除）和清空。
 * 模型看到的记忆全部在这里，没有隐藏的部分。
 */
export const MemorySetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const [clearing, setClearing] = useState(false)
  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memory')}</div>
          <div className={styles.description}>{t('memoryDescription')}</div>
        </div>
        <Select
          ariaLabel={t('memory')}
          value={enabled ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('memoryOn') },
            { value: 'off', label: t('memoryOff') },
          ]}
          onChange={(value) => {
            setMemoryEnabled(value === 'on')
            onMemoryToggled()
          }}
        />
      </div>
      <ProfileCell canOrganize={enabled && hasApiKey} />
      <MutedCell />
      <RecentCell />
      <LogCell />
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memoryClear')}</div>
          <div className={styles.description}>{t('memoryClearDescription')}</div>
        </div>
        <Button
          variant="dangerOutlined"
          size="m"
          className={styles.cellButton}
          onClick={() => setClearing(true)}
        >
          {t('memoryClearAction')}
        </Button>
      </div>
      {clearing ? <ClearConfirm onClose={() => setClearing(false)} /> : null}
    </>
  )
}

const ProfileCell = ({ canOrganize }: { canOrganize: boolean }) => {
  const t = useTranslate()
  const profile = useMemory((state) => state.profile)
  const activity = useMemory((state) => state.activity)
  const failed = useMemory((state) => state.failed)
  const [draft, setDraft] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const content = profile?.content.trim() ?? ''
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

  const save = async () => {
    if (draft === null) {
      return
    }
    try {
      await saveProfile(draft)
      setDraft(null)
      showToast({ key: 'memorySaved' })
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
    }
  }

  const status = busy
    ? t(activity === 'digesting' ? 'memoryStatusDigesting' : 'memoryStatusDreaming')
    : failed
      ? t('memoryStatusFailed')
      : profile?.dreamedAt
        ? t('memoryStatusUpdated', { time: formatTime(profile.dreamedAt) })
        : t('memoryStatusNever')

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memoryProfile')}</div>
          <div
            className={clsx(styles.description, !busy && failed && styles.error)}
            aria-live="polite"
          >
            {status}
          </div>
        </div>
        {draft === null ? (
          <div className={memoryStyles.actions}>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={busy || !canOrganize}
              onClick={() => void organize()}
            >
              {t('memoryOrganize')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={busy}
              onClick={() => setDraft(content)}
            >
              {t('memoryEdit')}
            </Button>
          </div>
        ) : null}
      </div>
      {draft === null ? (
        <div className={clsx(memoryStyles.profile, !content && memoryStyles.empty)}>
          {content || t('memoryProfileEmpty')}
        </div>
      ) : (
        <>
          <textarea
            className={memoryStyles.editor}
            aria-label={t('memoryProfile')}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={memoryStyles.editorActions}>
            <Button variant="outlined" size="m" onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button size="m" onClick={() => void save()}>
              {t('memorySave')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/** 「别再提这件事」攒下的清单；没有时不显示这一栏 */
const MutedCell = () => {
  const t = useTranslate()
  const muted = useMemory((state) => state.profile?.muted)
  if (!muted?.length) {
    return null
  }
  const restore = async (text: string) => {
    try {
      await unmuteItem(text)
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
    }
  }
  return (
    <div className={styles.cell}>
      <div className={styles.text}>
        <div className={styles.label}>{t('memoryMuted')}</div>
        <div className={styles.description}>{t('memoryMutedDescription')}</div>
      </div>
      <ul className={memoryStyles.list}>
        {muted.map((text) => (
          <li key={text} className={memoryStyles.item}>
            <div className={memoryStyles.itemText}>
              <div className={memoryStyles.itemSummary}>{text}</div>
            </div>
            <Button
              variant="outlined"
              size="s"
              className={memoryStyles.itemButton}
              aria-label={`${t('memoryMutedRestore')}: ${text}`}
              onClick={() => void restore(text)}
            >
              {t('memoryMutedRestore')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const RecentCell = () => {
  const t = useTranslate()
  const digests = useMemory((state) => state.digests)
  const pending = useMemory((state) => state.pending)
  const visible = digests
    .filter((digest) => digest.summary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const waiting = Object.keys(pending).length

  const forget = async (sessionId: string) => {
    try {
      await forgetDigest(sessionId)
    } catch {
      showToast({ key: 'memorySaveFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.text}>
        <div className={styles.label}>{t('memoryRecent')}</div>
        <div className={styles.description}>
          {waiting ? t('memoryRecentWaiting', { count: waiting }) : t('memoryRecentDescription')}
        </div>
      </div>
      {visible.length ? (
        <ul className={memoryStyles.list}>
          {visible.map((digest) => (
            <li key={digest.sessionId} className={memoryStyles.item}>
              <div className={memoryStyles.itemText}>
                <div className={memoryStyles.itemTitle}>
                  <span className={memoryStyles.itemName}>
                    {digest.title || t('memoryUntitled')}
                  </span>
                  <span className={memoryStyles.itemTime}>{formatTime(digest.updatedAt)}</span>
                </div>
                <div className={memoryStyles.itemSummary}>{digest.summary}</div>
              </div>
              <Button
                variant="outlined"
                size="s"
                className={memoryStyles.itemButton}
                aria-label={`${t('delete')}: ${digest.title || t('memoryUntitled')}`}
                onClick={() => void forget(digest.sessionId)}
              >
                {t('delete')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={clsx(memoryStyles.profile, memoryStyles.empty)}>
          {t('memoryRecentEmpty')}
        </div>
      )}
    </div>
  )
}

const TRIGGER_LABELS: Record<MemoryLogEntry['trigger'], TranslationKey> = {
  delay: 'memoryLogTriggerDelay',
  leave: 'memoryLogTriggerLeave',
  catchUp: 'memoryLogTriggerCatchUp',
  manual: 'memoryLogTriggerManual',
  first: 'memoryLogTriggerFirst',
  batch: 'memoryLogTriggerBatch',
  interval: 'memoryLogTriggerInterval',
}

const RESULT_LABELS: Record<MemoryLogEntry['result'], TranslationKey> = {
  saved: 'memoryLogResultSaved',
  skipped: 'memoryLogResultSkipped',
  discarded: 'memoryLogResultDiscarded',
  failed: 'memoryLogResultFailed',
}

/** 活动记录：每次摘要生成和档案整理的触发原因、结果和产出，用于追溯记忆从哪里来 */
const LogCell = () => {
  const t = useTranslate()
  const log = useMemory((state) => state.log)
  return (
    <div className={styles.cell}>
      <div className={styles.text}>
        <div className={styles.label}>{t('memoryLog')}</div>
        <div className={styles.description}>{t('memoryLogDescription')}</div>
      </div>
      {log.length ? (
        <ul className={clsx(memoryStyles.list, memoryStyles.log)}>
          {log.map((entry) => (
            <LogItem key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <div className={clsx(memoryStyles.profile, memoryStyles.empty)}>{t('memoryLogEmpty')}</div>
      )}
    </div>
  )
}

const LogItem = ({ entry }: { entry: MemoryLogEntry }) => {
  const t = useTranslate()
  const kind = t(entry.kind === 'digest' ? 'memoryLogDigest' : 'memoryLogProfile')
  const subject = entry.kind === 'digest' ? entry.title || t('memoryUntitled') : kind
  const note =
    entry.result === 'skipped'
      ? t('memoryLogSkippedDetail')
      : entry.reason === 'edited'
        ? t('memoryLogEditedDetail')
        : entry.reason === 'emptyOutput'
          ? t('memoryLogEmptyOutputDetail')
          : null
  return (
    <li className={memoryStyles.logItem}>
      <details>
        <summary className={memoryStyles.logSummary}>
          <span className={memoryStyles.logLine}>
            <span className={memoryStyles.itemTime}>{formatTime(entry.at)}</span>
            <span className={memoryStyles.logKind}>{kind}</span>
            {entry.kind === 'digest' ? (
              <span className={memoryStyles.itemName}>{subject}</span>
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
              {t('memoryLogSources', {
                titles: entry.sources.map((title) => title || t('memoryUntitled')).join(' / '),
              })}
            </div>
          ) : null}
          {note ? <div className={memoryStyles.logMeta}>{note}</div> : null}
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
      title={t('memoryClearConfirmTitle')}
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
