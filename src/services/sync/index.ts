import { create } from 'zustand'
import * as db from '../chat/db.js'
import { onSyncedSettingsChange, useSettings } from '../settings.js'
import { SyncAuthError } from './backend.js'
import { listSyncCollections, registerSyncCollection } from './collection.js'
import { memoryCollection } from './collections/memory.js'
import { sessionsCollection } from './collections/sessions.js'
import { settingsCollection } from './collections/settings.js'
import { runSync, TOMBSTONE_TTL } from './engine.js'
import {
  getSyncProvider,
  listSyncProviders,
  registerSyncProvider,
  type SyncProvider,
} from './provider.js'
import { googleDriveProvider } from './providers/googleDrive/index.js'
import { mockProvider } from './providers/mock.js'

/**
 * 云端同步的装配与调度：注册内置的服务商和数据种类，决定什么时候跑一轮同步。
 * 同步本身在 engine.ts，这里不含任何服务商或数据种类的细节。详见本目录的 README。
 */

const DEV = process.env.NODE_ENV !== 'production'

// 被依赖的种类在前：记忆里的近期摘要只在对应会话已经在本地时才写入
registerSyncCollection(sessionsCollection)
registerSyncCollection(memoryCollection)
registerSyncCollection(settingsCollection)

registerSyncProvider(googleDriveProvider)
if (DEV) {
  registerSyncProvider(mockProvider)
}

/** 本地改动后等这么久再同步，连续的改动（流式生成、连续操作）合并成一轮 */
const DEBOUNCE = 5000
/** 页面可见时每隔这么久拉取一次其他设备的改动 */
const POLL_INTERVAL = 5 * 60_000
/** 有条目被推迟（正在生成回复、数据还没加载完）时，过这么久再试 */
const RETRY_DELAY = 15_000
const STARTUP_DELAY = 1000

/** 上次同步用的「服务商:账号」；变了就丢掉全部同步基线 */
const IDENTITY_KEY = 'chat-demo:sync-identity'
const LAST_SYNCED_KEY = 'chat-demo:sync-last-synced-at'

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时只影响展示和是否多合并一轮
  }
}

type SyncState = {
  running: boolean
  /** 最近一次完整成功的同步时间 */
  lastSyncedAt: number | null
  /** 最近一次同步的错误信息；成功后清除。授权失效不算在这里，看服务商的授权状态 */
  error: string | null
}

export const useSync = create<SyncState>(() => ({
  running: false,
  lastSyncedAt: Number(read(LAST_SYNCED_KEY)) || null,
  error: null,
}))

/** 当前构建里可选的服务商；开发专用的只在开发构建出现 */
export const availableSyncProviders = (): SyncProvider[] =>
  listSyncProviders().filter((provider) => DEV || !provider.devOnly)

/** 设置里选中的服务商；选中的不可用时退回第一个可用的 */
export const activeSyncProvider = (
  id: string = useSettings.getState().syncProvider
): SyncProvider | undefined => {
  const provider = getSyncProvider(id)
  return provider && (DEV || !provider.devOnly) ? provider : availableSyncProviders()[0]
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message || error.name : String(error)

let timer: number | undefined
let running: Promise<void> | null = null
let queued = false

const schedule = (delay: number) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void syncNow(), delay)
}

const execute = async (provider: SyncProvider) => {
  useSync.setState({ running: true })
  try {
    const collections = listSyncCollections()
    const identity = `${provider.id}:${provider.auth?.getState().account?.id ?? ''}`
    if (read(IDENTITY_KEY) !== identity) {
      await Promise.all(collections.map((collection) => collection.resetBaselines()))
      write(IDENTITY_KEY, identity)
    }
    const result = await runSync(provider.createBackend(), collections)
    if (result.failed > 0) {
      useSync.setState({ error: errorMessage(result.error) })
    } else {
      const lastSyncedAt = Date.now()
      write(LAST_SYNCED_KEY, String(lastSyncedAt))
      useSync.setState({ lastSyncedAt, error: null })
    }
    if (result.deferred > 0) {
      schedule(RETRY_DELAY)
    }
  } catch (error) {
    // 授权失效由服务商的授权状态体现，界面提示重新连接
    useSync.setState({ error: error instanceof SyncAuthError ? null : errorMessage(error) })
  } finally {
    useSync.setState({ running: false })
  }
}

const run = async () => {
  const provider = activeSyncProvider()
  if (!useSettings.getState().syncEnabled || !provider) {
    return
  }
  if (provider.auth && provider.auth.getState().status !== 'signedIn') {
    return
  }
  // 多个标签页同时只跑一轮；别的标签页正在同步时本页这一轮直接跳过
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request('chat-demo:sync', { ifAvailable: true }, async (lock) => {
      if (lock) {
        await execute(provider)
      }
    })
  } else {
    await execute(provider)
  }
}

/** 立即同步一轮；已经在同步时等它结束后再补一轮。同步关闭或未连接时什么都不做。 */
export const syncNow = (): Promise<void> => {
  if (running) {
    queued = true
    return running
  }
  window.clearTimeout(timer)
  running = run().finally(() => {
    running = null
    if (queued) {
      queued = false
      schedule(DEBOUNCE)
    }
  })
  return running
}

let initialized = false

/** 告诉各服务商自己是否正在被使用：没开同步或没选中它时，不应自行续期、加载登录脚本 */
const updateActiveProvider = () => {
  const active = useSettings.getState().syncEnabled ? activeSyncProvider() : undefined
  for (const provider of listSyncProviders()) {
    provider.auth?.setActive?.(provider === active)
  }
}

/** 应用启动时调用一次：订阅本地改动、设置和授权的变化，按需触发同步 */
export const initSync = () => {
  if (initialized) {
    return
  }
  initialized = true
  void db
    .pruneSyncTombstones(Date.now() - TOMBSTONE_TTL)
    .catch(db.reportStorageError('prune sync tombstones'))
  db.onLocalChange(() => schedule(DEBOUNCE))
  updateActiveProvider()
  onSyncedSettingsChange(() => schedule(DEBOUNCE))
  useSettings.subscribe((state, previous) => {
    if (
      state.syncEnabled !== previous.syncEnabled ||
      state.syncProvider !== previous.syncProvider
    ) {
      updateActiveProvider()
      schedule(0)
    }
  })
  for (const provider of listSyncProviders()) {
    provider.auth?.subscribe(() => schedule(0))
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedule(0)
    }
  })
  window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      void syncNow()
    }
  }, POLL_INTERVAL)
  schedule(STARTUP_DELAY)
}
