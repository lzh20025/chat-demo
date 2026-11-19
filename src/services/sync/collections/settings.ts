import * as db from '../../chat/db.js'
import {
  applySyncedSettings,
  exportSyncedSettings,
  syncedSettingsModifiedAt,
  type SyncedSettings,
} from '../../settings.js'
import type { SyncCollection } from '../collection.js'

/**
 * 设置：只同步偏好类的设置（语言、主题、模型、思考强度、朗读音色、记忆开关、自定义指令、各服务商的模型与接口地址），
 * 合成一个远端文件。API Key 永远不离开本机，白名单见 services/settings.ts 的 SYNCED_KEYS。
 * 冲突时整份取最近改动的一方。
 */

const KEY = 'main'
const META_KEY = 'settings:main'

const parseSettings = (data: unknown): SyncedSettings | null =>
  typeof data === 'object' &&
  data !== null &&
  Object.values(data).every((value) => value === null || typeof value === 'string')
    ? (data as SyncedSettings)
    : null

export const settingsCollection: SyncCollection<SyncedSettings> = {
  id: 'settings',

  ready: () => true,

  async listLocal() {
    const modifiedAt = syncedSettingsModifiedAt()
    // 从没改过设置（都是默认值）时不列出：远端有就直接下载
    if (modifiedAt === 0) {
      return []
    }
    const meta = await db.getSyncMeta(META_KEY)
    return [{ key: KEY, modifiedAt, syncedAt: meta?.syncedAt, syncedRev: meta?.syncedRev }]
  },

  read: async () => exportSyncedSettings(),

  parse: parseSettings,

  async write(_key, data, sync) {
    if ((syncedSettingsModifiedAt() || undefined) !== sync.expect) {
      return 'deferred'
    }
    applySyncedSettings(data, sync.modifiedAt)
    if (sync.rev !== undefined) {
      await db.markSynced(META_KEY, sync.rev, sync.modifiedAt)
    }
    return 'applied'
  },

  remove: async () => 'deferred',

  merge: (local, remote, { localModifiedAt, remoteModifiedAt }) =>
    remoteModifiedAt > localModifiedAt ? remote : local,

  markSynced: (_key, rev, modifiedAt) => db.markSynced(META_KEY, rev, modifiedAt),

  forget: async () => {},

  resetBaselines: () => db.resetSyncBaselines(META_KEY),
}
