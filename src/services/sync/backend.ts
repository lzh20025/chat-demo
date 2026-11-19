/**
 * 同步后端：远端的一组扁平文件。引擎只通过这个接口读写远端，不关心背后是哪家服务。
 * rev 是文件内容的版本标识，对引擎不透明，只用来判断「和上次同步时是不是同一份」。
 */
export type RemoteEntry = { name: string; rev: string }

export interface SyncBackend {
  /** 列出全部文件及其当前版本 */
  list(): Promise<RemoteEntry[]>
  read(name: string): Promise<string>
  /** 单个文件的当前版本；不存在返回 null。上传前用它确认远端没有在规划之后变化 */
  stat(name: string): Promise<RemoteEntry | null>
  /** 新建或覆盖，返回写入后的版本 */
  write(name: string, text: string): Promise<RemoteEntry>
  /** 文件不存在时不报错 */
  remove(name: string): Promise<void>
}

/** 授权失效（未登录、令牌过期且无法续期）：引擎立即停止本轮同步，由界面提示重新连接 */
export class SyncAuthError extends Error {
  constructor(message = 'Sync provider is not authorized') {
    super(message)
    this.name = 'SyncAuthError'
  }
}
