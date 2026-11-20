import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { activeSyncProvider } from '../../services/sync/index.js'
import { openSettings } from './settingsDialogState.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useAuthState } from './SyncSetting.js'

/**
 * 同步因授权失效而暂停时，在主界面顶部提示并一键继续，不需要到设置里找「重新连接」。
 * Google 的访问令牌约一小时过期、关掉标签页后也不保留，后台续期又常被浏览器拦截，这时就会出现。
 * className：沿用主界面其他提示条的样式。
 */
export const SyncPausedNotice = ({ className }: { className: string }) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.syncEnabled)
  const providerId = useSettings((state) => state.syncProvider)
  const provider = activeSyncProvider(providerId)
  const auth = provider?.auth ?? null
  // 要重新填写信息的服务商（如 WebDAV 改了密码）不能就地继续，打开设置里的表单
  const needsForm = (provider?.connectFields?.length ?? 0) > 0
  const authState = useAuthState(auth)
  const [resuming, setResuming] = useState(false)

  if (!enabled || !auth || authState?.status !== 'expired') {
    return null
  }

  const resume = async () => {
    if (needsForm) {
      openSettings('data')
      return
    }
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
      <span>
        {t('syncPausedNotice', {
          provider: provider ? t(provider.label) : '',
          account: authState.account?.label ?? '',
        })}
      </span>
      <Button variant="outlined" size="s" disabled={resuming} onClick={() => void resume()}>
        {t(needsForm ? 'syncOpenSettings' : 'syncResume')}
      </Button>
    </div>
  )
}
