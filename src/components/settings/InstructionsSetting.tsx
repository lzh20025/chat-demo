import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { INSTRUCTIONS_LIMIT } from '../../services/instructions.js'
import { setCustomInstructions, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import memoryStyles from './MemorySetting.module.css'
import styles from './Settings.module.css'

/**
 * 设置 →「通用设置」里的自定义指令：用户希望每次回答都遵守的要求。
 * 只由用户编辑，与记忆无关；保存后对之后的每条回答立即生效。
 */
export const InstructionsSetting = () => {
  const t = useTranslate()
  const saved = useSettings((state) => state.customInstructions)
  const [draft, setDraft] = useState<string | null>(null)

  const save = () => {
    if (draft === null) {
      return
    }
    setCustomInstructions(draft)
    setDraft(null)
    showToast({ key: 'memorySaved' })
  }

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('customInstructions')}</div>
          <div className={styles.description}>{t('customInstructionsDescription')}</div>
        </div>
        {draft === null ? (
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            onClick={() => setDraft(saved)}
          >
            {t('memoryEdit')}
          </Button>
        ) : null}
      </div>
      {draft === null ? (
        <div className={clsx(memoryStyles.profile, !saved && memoryStyles.empty)}>
          {saved || t('customInstructionsEmpty')}
        </div>
      ) : (
        <>
          <textarea
            className={clsx(memoryStyles.editor, memoryStyles.instructionsEditor)}
            aria-label={t('customInstructions')}
            placeholder={t('customInstructionsPlaceholder')}
            maxLength={INSTRUCTIONS_LIMIT}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={memoryStyles.editorActions}>
            <Button variant="outlined" size="m" onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button size="m" onClick={save}>
              {t('memorySave')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
