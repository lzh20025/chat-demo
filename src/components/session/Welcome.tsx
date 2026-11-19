import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { setNewChatTemporary, useChatStore } from '../../services/chat/store.js'
import { IconTemporaryOutline14 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/**
 * 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底。
 * 临时对话开关固定在页面右上角；选中后的说明浮在问候语上方，不占位，输入框不动
 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const temporary = useChatStore((state) => state.newChatTemporary)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.temporaryToggle}>
        <Tooltip content={t('temporaryChatTooltip')} placement="bottom">
          <button
            type="button"
            className={clsx(styles.toggle, temporary && styles.selected)}
            aria-pressed={temporary}
            onClick={() => setNewChatTemporary(!temporary)}
          >
            <IconTemporaryOutline14 />
            <span>{t('temporaryChat')}</span>
          </button>
        </Tooltip>
      </div>
      <div className={styles.welcome}>
        <div className={styles.heading}>
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
          {temporary ? (
            <div className={styles.temporaryHint}>
              <IconTemporaryOutline14 />
              <span>{t('temporaryChatHint')}</span>
            </div>
          ) : null}
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
