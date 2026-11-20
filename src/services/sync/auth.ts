/**
 * 同步服务商的授权。应用没有自己的账号系统，登录的是服务商的账号（如 Google）。
 * unconfigured：构建时没有提供必要的配置（如 OAuth Client ID）；
 * signedOut：还没有连接；signedIn：已连接且令牌有效；
 * expired：连接过，但令牌已过期且无法静默续期，同步暂停；主界面顶部提示，需要用户再点一次连接。
 */
export type SyncAuthStatus = 'unconfigured' | 'signedOut' | 'signedIn' | 'expired'

export type SyncAccount = {
  /** 服务商内稳定的账号标识：换账号后引擎据此丢弃旧账号的同步基线 */
  id: string
  /** 展示给用户看的名字，一般是邮箱 */
  label: string
}

export type SyncAuthState = {
  status: SyncAuthStatus
  account?: SyncAccount
  /** 上一次连接失败的原因，如从服务商授权页回来时出错；下一次连接时清除 */
  error?: string
}

export interface SyncAuth {
  getState(): SyncAuthState
  subscribe(listener: () => void): () => void
  /** 界面即将展示连接按钮时调用：提前加载登录要用的脚本，点击后能立刻弹出窗口 */
  prepare?(): void
  /**
   * 发起连接，必须在用户点击的回调里调用：可能弹出服务商的授权窗口，或跳转到服务商的授权页再回来。
   * 有 connectFields 的服务商由界面传入用户填写的值，连接前应先验证能否访问。
   */
  connect(values?: Record<string, string>): Promise<void>
  /** 表单的预填值（如重新连接时沿用的地址和用户名，不含密码） */
  connectDefaults?(): Record<string, string>
  /** 断开并撤销授权；已同步到远端的数据不受影响 */
  disconnect(): Promise<void>
  /** 取一个可用的访问令牌；refresh 为 true 时丢弃手上的令牌重新获取。拿不到返回 null */
  getToken(options?: { refresh?: boolean }): Promise<string | null>
}
