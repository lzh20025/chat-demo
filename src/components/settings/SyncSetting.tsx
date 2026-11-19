import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { setSyncEnabled, setSyncProvider, useSettings } from '../../services/settings.js'
import type { SyncAuth, SyncAuthState } from '../../services/sync/auth.js'
import {
  activeSyncProvider,
  availableSyncProviders,
  syncNow,
  useSync,
} from '../../services/sync/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

const noSubscribe = () => () => {}

/** 订阅服务商的授权状态；不需要登录的服务商为 null */
const useAuthState = (auth: SyncAuth | null): SyncAuthState | null =>
  useSyncExternalStore(auth?.subscribe ?? noSubscribe, () => auth?.getState() ?? null)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * 设置 →「数据管理」里的云端同步：开关、同步到哪里、连接的账号和同步状态。
 * 这里只认 SyncProvider / SyncAuth 接口，不含任何服务商特有的逻辑；新增服务商后会自动出现在「同步到」里。
 * disabled：正在导入或删除历史时不允许操作。
 */
export const SyncSetting = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const enabled = useSettings((state) => state.syncEnabled)
  const providerId = useSettings((state) => state.syncProvider)
  const providers = availableSyncProviders()
  const provider = activeSyncProvider(providerId)
  const auth = provider?.auth ?? null
  const authState = useAuthState(auth)
  const { running, lastSyncedAt, error } = useSync()
  const [connecting, setConnecting] = useState(false)

  // 提前加载登录脚本，点「连接」时能立刻弹出授权窗口
  useEffect(() => auth?.prepare?.(), [auth])

  if (!provider) {
    return null
  }

  const connected = !auth || authState?.status === 'signedIn'
  const account = authState?.account?.label ?? ''
  const accountStatus: TranslationMessage & { error?: boolean } = !auth
    ? { key: 'syncAccountNone' }
    : authState?.status === 'unconfigured'
      ? { key: 'syncAccountUnconfigured' }
      : authState?.status === 'signedIn'
        ? { key: 'syncAccountSignedIn', params: { account } }
        : authState?.status === 'expired'
          ? { key: 'syncAccountExpired', params: { account }, error: true }
          : { key: 'syncAccountSignedOut' }

  const syncStatus: TranslationMessage & { error?: boolean } = !enabled
    ? { key: 'syncStatusOff' }
    : !connected
      ? { key: 'syncStatusNotConnected' }
      : running
        ? { key: 'syncStatusRunning' }
        : error
          ? { key: 'syncStatusFailed', params: { message: error }, error: true }
          : lastSyncedAt
            ? {
                key: 'syncStatusDone',
                params: { time: new Date(lastSyncedAt).toLocaleString(locale) },
              }
            : { key: 'syncStatusNever' }

  const connect = async () => {
    if (!auth) {
      return
    }
    setConnecting(true)
    try {
      await auth.connect()
    } catch (reason) {
      showToast({
        key: 'syncConnectFailed',
        params: { message: errorMessage(reason) },
        type: 'error',
      })
    } finally {
      setConnecting(false)
    }
  }

  return (
    <>
      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('syncTitle')}</div>
          <div className={styles.description}>{t('syncDescription')}</div>
        </div>
        <Switch
          checked={enabled}
          ariaLabel={t('syncTitle')}
          disabled={disabled}
          onChange={setSyncEnabled}
        />
      </div>
      {enabled ? (
        <>
          {providers.length > 1 ? (
            <div className={`${styles.cell} ${styles.row}`}>
              <div className={styles.text}>
                <div className={styles.label}>{t('syncProvider')}</div>
              </div>
              <Select
                value={provider.id}
                ariaLabel={t('syncProvider')}
                disabled={disabled || running}
                options={providers.map((item) => ({ value: item.id, label: t(item.label) }))}
                onChange={setSyncProvider}
              />
            </div>
          ) : null}
          <div className={`${styles.cell} ${styles.row}`}>
            <div className={styles.text}>
              <div className={styles.label}>
                {providers.length > 1 ? t('syncAccount') : t(provider.label)}
              </div>
              <div className={accountStatus.error ? styles.error : styles.description}>
                {t(accountStatus.key, accountStatus.params)}
              </div>
            </div>
            {auth && authState?.status !== 'unconfigured' ? (
              authState?.status === 'signedIn' ? (
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={disabled || running}
                  onClick={() => void auth.disconnect()}
                >
                  {t('syncDisconnect')}
                </Button>
              ) : (
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  disabled={disabled || connecting}
                  onClick={() => void connect()}
                >
                  {t(authState?.status === 'expired' ? 'syncReconnect' : 'syncConnect')}
                </Button>
              )
            ) : null}
          </div>
          <div className={`${styles.cell} ${styles.row}`}>
            <div className={styles.text}>
              <div className={styles.label}>{t('syncStatus')}</div>
              <div
                className={syncStatus.error ? styles.error : styles.description}
                role="status"
                aria-live="polite"
              >
                {t(syncStatus.key, syncStatus.params)}
              </div>
            </div>
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={disabled || running || !connected}
              onClick={() => void syncNow()}
            >
              {t('syncNow')}
            </Button>
          </div>
        </>
      ) : null}
    </>
  )
}
