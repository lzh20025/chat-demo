/**
 * 同步的数据种类：会话、记忆、设置各是一个 collection。
 * 引擎不认识具体数据，只通过这个接口列出本地条目、读写内容、合并冲突。
 * 新增一种要同步的数据只需实现这个接口并注册。
 */

/** 本地的一个可同步条目及其同步状态 */
export type LocalEntry = {
  key: string
  /** 本地最近一次改动的时间 */
  modifiedAt: number
  /** 上次同步成功时的 modifiedAt；与 modifiedAt 不同表示本地有未同步的改动 */
  syncedAt?: number
  /** 上次同步成功时远端的版本 */
  syncedRev?: string
  /** 本地已删除，等着把删除带到远端 */
  deletedAt?: number
}

/** 把远端（或合并后）的内容写回本地时附带的同步状态 */
export type SyncWrite = {
  /** 规划时看到的本地改动时间；写入时本地已经又变了就应放弃，返回 deferred */
  expect: number | undefined
  /** 写入后的改动时间 */
  modifiedAt: number
  /** 给了表示内容与远端这个版本一致；没给表示是合并结果，引擎随后会上传 */
  rev?: string
}

/** deferred：现在不方便（正在生成回复、本地刚又改了），留到下一轮 */
export type ApplyResult = 'applied' | 'deferred'

export interface SyncCollection<T = unknown> {
  /** 种类标识，也是远端文件名的前缀：`<id>-<key>.json` */
  id: string
  /** 本地数据还没准备好（未加载完、正在导入历史）时返回 false，本轮跳过这个种类 */
  ready(): boolean
  listLocal(): Promise<LocalEntry[]>
  /** 读出要上传的内容；条目不存在或暂时不能读（如正在生成回复）返回 null */
  read(key: string): Promise<T | null>
  /** 校验远端内容；不认识的返回 null，引擎不会写回 */
  parse(data: unknown): T | null
  write(key: string, data: T, sync: SyncWrite): Promise<ApplyResult>
  /** 远端已删除：在本地删除，不留删除标记 */
  remove(key: string, expect: number | undefined): Promise<ApplyResult>
  /** 两边都改了：合并成一份。必须是纯函数 */
  merge(local: T, remote: T, times: { localModifiedAt: number; remoteModifiedAt: number }): T
  markSynced(key: string, rev: string, modifiedAt: number): Promise<void>
  /** 本地的删除已带到远端，删除标记可以清掉 */
  forget(key: string, deletedAt: number): Promise<void>
  /** 换了服务商或账号：丢掉这个种类的全部同步基线 */
  resetBaselines(): Promise<void>
}

const collections: SyncCollection[] = []

/** 按注册顺序同步：被依赖的种类先注册（记忆里的摘要依赖会话已经在本地） */
export const registerSyncCollection = <T>(collection: SyncCollection<T>) => {
  const index = collections.findIndex((item) => item.id === collection.id)
  if (index >= 0) {
    collections[index] = collection as SyncCollection
  } else {
    collections.push(collection as SyncCollection)
  }
}

export const listSyncCollections = (): SyncCollection[] => [...collections]
