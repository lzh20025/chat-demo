import type { TranslationKey } from '../../i18n/index.js'
import type { SyncAuth } from './auth.js'
import type { SyncBackend } from './backend.js'

/**
 * 同步服务商：一种把数据存到别处的方式，由「授权」和「后端」两部分组成。
 * 新增服务商（WebDAV、OneDrive…）只需实现这个类型并注册，引擎和界面都不用改。
 */
export type SyncProvider = {
  id: string
  /** 界面上的名字 */
  label: TranslationKey
  /** 只在开发构建里出现（如本地模拟后端） */
  devOnly?: boolean
  /** 不需要登录的服务商为 null */
  auth: SyncAuth | null
  createBackend(): SyncBackend
}

const providers = new Map<string, SyncProvider>()

export const registerSyncProvider = (provider: SyncProvider) => {
  providers.set(provider.id, provider)
}

export const getSyncProvider = (id: string): SyncProvider | undefined => providers.get(id)

export const listSyncProviders = (): SyncProvider[] => [...providers.values()]
