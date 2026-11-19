import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { activeSyncProvider } from '../../services/sync/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useAuthState } from './SyncSetting.js'

/**
 * 同步因授权失效而暂停时，在主界面顶部提示并一键继续，不需要到设置里找「重新连接」。
 * 平时续期在用户点击页面时自动完成，只有续期没成功（如关掉了授权窗口）才会出现。
 * className：沿用主界面其他提示条的样式。
 */
export const SyncPausedNotice = ({ className }: { className: string }) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.syncEnabled)
  const providerId = useSettings((state) => state.syncProvider)
  const auth = activeSyncProvider(providerId)?.auth ?? null
  const authState = useAuthState(auth)
  const [resuming, setResuming] = useState(false)

  if (!enabled || !auth || authState?.status !== 'expired') {
    return null
  }

  const resume = async () => {
    setResuming(true)
    try {
      await auth.connect()
    } catch (reason) {
      showToast({
        key: 'syncConnectFailed',
        params: { message: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className={className} role="status">
      <span>{t('syncPausedNotice', { account: authState.account?.label ?? '' })}</span>
      <Button variant="outlined" size="s" disabled={resuming} onClick={() => void resume()}>
        {t('syncResume')}
      </Button>
    </div>
  )
}
