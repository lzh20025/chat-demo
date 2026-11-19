import type { LocalEntry } from './collection.js'

/**
 * 一轮同步要对某个条目做的事。
 * upload：本地有改动，远端没变（或没有）；download：远端变了，本地没改；
 * conflict：两边都变了，要合并；deleteLocal：远端已删除；
 * deleteRemote：本地已删除，远端没变；deleteConflict：本地删了，但远端在那之后可能又变了，要看时间；
 * tombstone：本地删了，远端文件已经没有，但远端的删除记录里还没有这条：补记进去，本地的删除标记留着；
 * forget：删除已经落到远端的删除记录里（或这条从没同步出去过），本地的删除标记可以清掉。
 */
export type SyncAction =
  | {
      type: 'upload'
      key: string
      local: LocalEntry
      remoteRev?: string
      /** 远端有这条的删除记录，但本地在那之后又改了：上传并撤掉删除记录 */
      clearTombstone?: boolean
    }
  | { type: 'download'; key: string; local?: LocalEntry; remoteRev: string }
  | { type: 'conflict'; key: string; local: LocalEntry; remoteRev: string }
  | { type: 'deleteLocal'; key: string; local: LocalEntry }
  | { type: 'deleteRemote'; key: string; local: LocalEntry; remoteRev: string }
  | { type: 'deleteConflict'; key: string; local: LocalEntry; remoteRev: string }
  | { type: 'tombstone'; key: string; local: LocalEntry }
  | { type: 'forget'; key: string; local: LocalEntry }

/**
 * 比较本地条目、远端文件和远端的删除记录，得出这一轮要做的事。纯函数。
 * 本地是否有改动看 modifiedAt 与 syncedAt 是否不同；远端是否变了看当前版本与 syncedRev 是否不同。
 * 拿不准时宁可多传一份，不删数据：远端文件不见了又没有删除记录时，按「重新上传」处理。
 */
export const planSync = (
  local: readonly LocalEntry[],
  remote: ReadonlyMap<string, string>,
  tombstones: Readonly<Record<string, number>>
): SyncAction[] => {
  const actions: SyncAction[] = []
  const seen = new Set<string>()

  for (const entry of local) {
    const { key } = entry
    seen.add(key)
    const remoteRev = remote.get(key)
    const dirty = entry.modifiedAt !== entry.syncedAt
    const remoteChanged = remoteRev !== entry.syncedRev

    if (entry.deletedAt !== undefined) {
      if (remoteRev === undefined) {
        // 从没上传过的条目别的设备本来就没有，不用留记录。
        // 同步出去过的：本地的删除标记一直留到在远端的删除记录里看到这条为止。
        // 记录是多台设备共用的文件，写入可能失败，也可能被别的设备同时写入的版本盖掉；没看到就再补一次。
        const recorded = entry.syncedRev === undefined || Object.hasOwn(tombstones, key)
        actions.push({ type: recorded ? 'forget' : 'tombstone', key, local: entry })
      } else if (remoteChanged) {
        actions.push({ type: 'deleteConflict', key, local: entry, remoteRev })
      } else {
        actions.push({ type: 'deleteRemote', key, local: entry, remoteRev })
      }
      continue
    }

    if (remoteRev === undefined) {
      const deletedAt = Object.hasOwn(tombstones, key) ? tombstones[key] : undefined
      if (deletedAt !== undefined && deletedAt >= entry.modifiedAt) {
        actions.push({ type: 'deleteLocal', key, local: entry })
      } else {
        actions.push({
          type: 'upload',
          key,
          local: entry,
          ...(deletedAt === undefined ? {} : { clearTombstone: true }),
        })
      }
    } else if (dirty && remoteChanged) {
      actions.push({ type: 'conflict', key, local: entry, remoteRev })
    } else if (dirty) {
      actions.push({ type: 'upload', key, local: entry, remoteRev })
    } else if (remoteChanged) {
      actions.push({ type: 'download', key, local: entry, remoteRev })
    }
  }

  for (const [key, remoteRev] of remote) {
    if (!seen.has(key)) {
      actions.push({ type: 'download', key, remoteRev })
    }
  }
  return actions
}
