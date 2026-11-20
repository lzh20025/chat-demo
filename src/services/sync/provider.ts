import type { TranslationKey } from '../../i18n/index.js'
import type { SyncAuth } from './auth.js'
import type { SyncBackend } from './backend.js'

/**
 * 连接前要用户填写的一项，如 WebDAV 的地址、用户名和密码。
 * 有这些项的服务商在设置里显示一个小表单，填写的值交给 SyncAuth.connect；没有的直接打开服务商的授权页。
 */
export type SyncConnectField = {
  /** connect 收到的值的键 */
  key: string
  label: TranslationKey
  type: 'url' | 'text' | 'password'
  placeholder?: string
  /** 浏览器自动填充的提示，如 username、current-password */
  autoComplete?: string
}

/**
 * 同步服务商：一种把数据存到别处的方式，由「授权」和「后端」两部分组成。
 * 新增服务商（WebDAV、OneDrive…）只需实现这个类型并注册，引擎和界面都不用改。
 */
export type SyncProvider = {
  id: string
  /** 界面上的名字 */
  label: TranslationKey
  /** 选中时显示在「同步到」下面的说明，如服务商的限制 */
  note?: TranslationKey
  /** 连接前要填写的信息；没有时点「连接」直接打开服务商的授权页 */
  connectFields?: SyncConnectField[]
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
