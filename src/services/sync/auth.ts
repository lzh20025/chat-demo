/**
 * 同步服务商的授权。应用没有自己的账号系统，登录的是服务商的账号（如 Google）。
 * unconfigured：构建时没有提供必要的配置（如 OAuth Client ID）；
 * signedOut：还没有连接；signedIn：已连接（令牌可能需要续期，由服务商在合适的时机自动完成）；
 * expired：连接过，但令牌已失效且自动续期没有成功，同步暂停，需要用户点一次「继续同步」或「重新连接」。
 */
export type SyncAuthStatus = 'unconfigured' | 'signedOut' | 'signedIn' | 'expired'

export type SyncAccount = {
  /** 服务商内稳定的账号标识：换账号后引擎据此丢弃旧账号的同步基线 */
  id: string
  /** 展示给用户看的名字，一般是邮箱 */
  label: string
}

export type SyncAuthState = { status: SyncAuthStatus; account?: SyncAccount }

export interface SyncAuth {
  getState(): SyncAuthState
  subscribe(listener: () => void): () => void
  /** 界面即将展示连接按钮时调用：提前加载登录要用的脚本，点击后能立刻弹出窗口 */
  prepare?(): void
  /** 发起登录授权；会弹出服务商的窗口，必须在用户点击的回调里调用 */
  connect(): Promise<void>
  /** 断开并撤销授权；已同步到远端的数据不受影响 */
  disconnect(): Promise<void>
  /**
   * 取一个可用的访问令牌；refresh 为 true 时丢弃手上的令牌。拿不到返回 null，
   * 例如续期需要等用户下一次点击：续期成功后服务商会通知订阅者，同步据此补上一轮。
   */
  getToken(options?: { refresh?: boolean }): Promise<string | null>
}
