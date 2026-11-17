import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { IconTemporaryOutline14 } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底。选了临时对话时问候语下方加一行说明 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const temporary = useChatStore((state) => state.newChatTemporary)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
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
