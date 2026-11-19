import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type IDBPTransaction,
  type StoreNames,
} from 'idb'
import { create } from 'zustand'
import {
  toSessionSummary,
  type Message,
  type MemoryItem,
  type Session,
  type SessionSummary,
} from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 15

/**
 * 多个标签页使用不同版本时的提示：
 * blocked：本页要升级数据库，但其他标签页还开着旧版本，需要关闭它们；
 * outdated：其他标签页已升级数据库，本页让出连接，需要刷新后继续使用。
 */
export const useStorageNotice = create<{ notice: 'blocked' | 'outdated' | null }>(() => ({
  notice: null,
}))

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 记忆：单个会话的近期摘要，键为会话 id；新会话开始时按时间倒序注入 system。 */
export type MemoryDigest = {
  sessionId: string
  title: string
  summary: string
  /** 生成摘要时的用户原话节选，供来源面板展示；旧摘要没有 */
  excerpt?: string
  /** 被摘要内容的最后活动时间，用于排序与展示 */
  updatedAt: number
  /** 摘要生成时间；晚于档案的 dreamedAt 表示尚未并入档案 */
  digestedAt: number
  /** 生成摘要时可见分支上的消息数，用于判断会话是否有新内容 */
  messageCount: number
  /**
   * 已覆盖到的最后一条消息的创建时间。之后创建的用户消息是「新内容」，只从新内容里提取记忆；
   * 编辑提问、切换分支后消息数会变少或变多，不能用消息数判断。旧摘要没有，按 updatedAt 处理。
   */
  coveredAt?: number
}

/**
 * 记忆的元数据，全局只有一条（id 固定为 profile）。条目本身在 memoryItems 里。
 * content 是旧版的 Markdown 档案，只在迁移成条目时读取，之后保持不动。
 */
export type MemoryProfile = {
  id: 'profile'
  content: string
  /** 用户最近一次改动记忆的时间：后台整理期间它变了，整理结果作废 */
  updatedAt: number
  /** 最近一次后台整理的时间；0 表示从未整理 */
  dreamedAt: number
  /** 用户要求不再提及的事：不记录，回答时不主动提起 */
  muted?: string[]
  /**
   * 已有摘要里还没清理掉的内容：别再提、删除、撤销、不用记之后，相关对话的摘要里可能还带着这件事。
   * at 是加入时间，在它之前生成的摘要清理完成前不注入；sessionIds 缺省表示所有对话，否则只涉及这些对话。
   * 记忆关闭、没有 API Key 或请求失败时会留下，启动或重新开启时重试。
   */
  unscrubbed?: { text: string; at: number; sessionIds?: string[] }[]
  /** 用户删除、撤销或拒绝过的记忆，留最近若干条：自动整理时不再原样记回来，也不再反复询问 */
  forgotten?: { text: string; at: number }[]
  /** 旧版档案迁移成条目的时间 */
  migratedAt?: number
}

/**
 * 记忆活动记录：每次生成摘要或整理档案留一条，用于追溯记忆从哪里来、为什么没更新。
 * 只保留最近若干条；内容含摘要与档案原文，清空记忆或删除对应对话时一并删除。
 */
export type MemoryLogEntry = {
  id: string
  /** 完成时间 */
  at: number
  durationMs: number
  /** digest：整理一个对话（摘要和提取记忆）；profile：后台整理全部记忆 */
  kind: 'digest' | 'profile'
  /**
   * 触发原因。对话：delay 回答完成后延时、leave 离开对话或切走窗口、catchUp 启动或重新开启时补齐、manual 立即整理；
   * 全部记忆：batch 新摘要累计到批量、interval 距上次整理超过间隔、full 记忆条数到上限、manual 立即整理。
   * first 是旧版档案首次生成，只出现在旧记录里。
   */
  trigger: 'delay' | 'leave' | 'catchUp' | 'manual' | 'first' | 'batch' | 'interval' | 'full'
  /** saved 已保存；skipped 模型判断没有值得记的内容；discarded 期间被用户操作覆盖或输出无效而作废；failed 请求失败 */
  result: 'saved' | 'skipped' | 'discarded' | 'failed'
  /** 摘要对应的会话 */
  sessionId?: string
  title?: string
  /** 整理时参考的摘要所属会话标题 */
  sources?: string[]
  /** 作废原因：edited 整理期间用户改动了记忆；emptyOutput 模型没有输出有效内容；unsafe 改动过多，疑似输出异常 */
  reason?: 'edited' | 'emptyOutput' | 'unsafe'
  /** 摘要正文、旧版整理后的档案全文，或失败时的错误信息 */
  detail: string
  /** 这次对记忆条目的改动 */
  changes?: { kind: 'added' | 'asked' | 'updated' | 'removed' | 'merged'; text: string }[]
}

/**
 * 同步元数据：记录每个可同步条目的本地改动时间和上次同步时的基线，同步引擎据此判断哪边变了。
 * 与数据在同一事务里写入，改动不会漏记。键为 `<种类>:<id>`：
 * `sessions:<会话 id>`、`memory:main`、`settings:main`，以及记忆条目、摘要的删除标记 `memoryItem:<id>`、`memoryDigest:<会话 id>`。
 */
export type SyncMeta = {
  key: string
  /** 本地最近一次改动的时间，同一条目上单调递增 */
  modifiedAt: number
  /** 上次同步成功时的 modifiedAt；与 modifiedAt 不同表示本地有未同步的改动 */
  syncedAt?: number
  /** 上次同步成功时远端文件的版本；与远端当前版本不同表示远端变了 */
  syncedRev?: string
  /** 本地已删除（墓碑）：等同步时把删除带到远端 */
  deletedAt?: number
}

export const SESSION_SYNC_PREFIX = 'sessions:'
export const MEMORY_SYNC_KEY = 'memory:main'
const MEMORY_ITEM_SYNC_PREFIX = 'memoryItem:'
const MEMORY_DIGEST_SYNC_PREFIX = 'memoryDigest:'

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  memoryDigests: { key: string; value: MemoryDigest }
  memoryProfile: { key: string; value: MemoryProfile }
  memoryLog: { key: string; value: MemoryLogEntry }
  memoryItems: { key: string; value: MemoryItem }
  syncMeta: { key: string; value: SyncMeta }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      if (!db.objectStoreNames.contains('memoryDigests')) {
        db.createObjectStore('memoryDigests', { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains('memoryProfile')) {
        db.createObjectStore('memoryProfile', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('memoryLog')) {
        db.createObjectStore('memoryLog', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('memoryItems')) {
        db.createObjectStore('memoryItems', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'key' })
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
    blocked() {
      // 其他标签页还开着旧版本，升级要等它们关闭；关闭后会自动继续
      useStorageNotice.setState({ notice: 'blocked' })
    },
    blocking(_currentVersion, _blockedVersion, event) {
      // 其他标签页要升级数据库：关闭连接让它继续，本页之后的读写需要刷新页面
      ;(event.target as IDBDatabase).close()
      dbPromise = null
      useStorageNotice.setState({ notice: 'outdated' })
    },
    terminated() {
      dbPromise = null
    },
  })
    .then((db) => {
      if (useStorageNotice.getState().notice === 'blocked') {
        useStorageNotice.setState({ notice: null })
      }
      return db
    })
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      dbPromise = null
      throw error
    }))

type SyncMetaStore = IDBPObjectStore<ChatDB, ArrayLike<StoreNames<ChatDB>>, 'syncMeta', 'readwrite'>
type WriteTransaction = IDBPTransaction<ChatDB, ArrayLike<StoreNames<ChatDB>>, 'readwrite'>

const localChangeListeners = new Set<() => void>()

/** 可同步的数据在本页被改动后通知；同步写回的数据不通知。 */
export const onLocalChange = (listener: () => void): (() => void) => {
  localChangeListeners.add(listener)
  return () => {
    localChangeListeners.delete(listener)
  }
}

const notifyLocalChange = () => {
  for (const listener of localChangeListeners) {
    listener()
  }
}

/** 同一条目的改动时间严格递增，时钟回拨时也能看出「变过」 */
const nextModifiedAt = (previous?: number) => Math.max(Date.now(), (previous ?? 0) + 1)

const syncBaseline = (meta: SyncMeta | undefined) =>
  meta?.syncedRev === undefined ? {} : { syncedAt: meta.syncedAt, syncedRev: meta.syncedRev }

/** 标记条目有本地改动；之前的删除标记随之取消 */
const touchSync = async (store: SyncMetaStore, key: string) => {
  const meta = await store.get(key)
  await store.put({ key, modifiedAt: nextModifiedAt(meta?.modifiedAt), ...syncBaseline(meta) })
}

/** 标记条目已在本地删除 */
const tombstoneSync = async (store: SyncMetaStore, key: string) => {
  const meta = await store.get(key)
  const at = nextModifiedAt(meta?.modifiedAt)
  await store.put({ key, modifiedAt: at, deletedAt: at, ...syncBaseline(meta) })
}

const prefixRange = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}\uffff`)

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncMeta'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
        // 临时对话不同步
        if (!session.temporary) {
          await touchSync(tx.objectStore('syncMeta'), SESSION_SYNC_PREFIX + session.id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  if (!session.temporary) {
    notifyLocalChange()
  }
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'syncMeta'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
          if (!session.temporary) {
            await touchSync(tx.objectStore('syncMeta'), SESSION_SYNC_PREFIX + id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(SESSION_REMOVAL_STORES, 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const meta = tx.objectStore('syncMeta')
        const { summary, hadDigest } = await removeSessionRecords(tx, sessionId)
        if (summary && !summary.temporary) {
          await tombstoneSync(meta, SESSION_SYNC_PREFIX + sessionId)
        }
        // 摘要随对话一起删除也是一次记忆改动：留下删除标记，同步时远端和其他设备上的这条摘要也删除，
        // 否则对话删了，它的摘要还留在云端的记忆文件里。
        if (hadDigest) {
          await tombstoneSync(meta, MEMORY_DIGEST_SYNC_PREFIX + sessionId)
          await touchSync(meta, MEMORY_SYNC_KEY)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

const SESSION_REMOVAL_STORES = [
  'sessions',
  'sessionSummaries',
  'files',
  'memoryDigests',
  'memoryLog',
  'syncMeta',
] as const

/** 删除会话及其摘要、摘要记录和不再被引用的原件；返回删除前的列表元数据，以及它之前有没有摘要。 */
const removeSessionRecords = async (tx: WriteTransaction, sessionId: string) => {
  const summaries = tx.objectStore('sessionSummaries')
  const summary = await summaries.get(sessionId)
  await tx.objectStore('sessions').delete(sessionId)
  // 删除对话时同时删除它的近期摘要和摘要记录；已并入用户档案的内容由用户在记忆设置中管理。
  const hadDigest = (await tx.objectStore('memoryDigests').count(sessionId)) > 0
  await tx.objectStore('memoryDigests').delete(sessionId)
  await deleteLogEntries(tx.objectStore('memoryLog'), sessionId)
  await summaries.delete(sessionId)
  for (const id of summary?.fileIds ?? []) {
    if ((await summaries.index('fileIds').count(id)) === 0) {
      await tx.objectStore('files').delete(id)
    }
  }
  return { summary, hadDigest }
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    [
      'sessions',
      'sessionSummaries',
      'files',
      'sessionsStaging',
      'filesStaging',
      'memoryDigests',
      'memoryLog',
      'syncMeta',
    ],
    'readwrite'
  )
  const meta = tx.objectStore('syncMeta')
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        // 被替换掉的会话记为已删除，同步时从远端移除；随后写入的同 id 会话会取消这个标记。
        for (const summary of await tx.objectStore('sessionSummaries').getAll()) {
          if (!summary.temporary) {
            await tombstoneSync(meta, SESSION_SYNC_PREFIX + summary.id)
          }
        }
        await tx.objectStore('sessionSummaries').clear()
        // 会话整体被替换，旧会话的近期摘要和活动记录随之失效；摘要逐条留下删除标记，同步时从远端删除。
        for (const sessionId of await tx.objectStore('memoryDigests').getAllKeys()) {
          await tombstoneSync(meta, MEMORY_DIGEST_SYNC_PREFIX + sessionId)
        }
        await tx.objectStore('memoryDigests').clear()
        await tx.objectStore('memoryLog').clear()
        await touchSync(meta, MEMORY_SYNC_KEY)
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
          if (!summary.temporary) {
            await touchSync(meta, SESSION_SYNC_PREFIX + summary.id)
          }
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  notifyLocalChange()
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/**
 * 导入完成后把暂存合并进正式数据：只添加本地没有的会话及其图片原件，已有会话、原件和记忆保持不变。
 * 同一事务内完成并清空暂存；事务失败时整体回滚，正式数据不变。
 */
export const mergeStaging = async (): Promise<{ added: SessionSummary[]; skipped: number }> => {
  const added: SessionSummary[] = []
  let skipped = 0
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'syncMeta'],
    'readwrite'
  )
  const merge = async () => {
    try {
      const sessions = tx.objectStore('sessions')
      const files = tx.objectStore('files')
      // 只移入新增会话引用的原件，被跳过的会话不留下无主文件。
      const fileIds = new Set<string>()
      for (
        let cursor = await tx.objectStore('sessionsStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        if ((await sessions.count(cursor.key)) > 0) {
          skipped += 1
          continue
        }
        const summary = storedSummary(cursor.value)
        await sessions.put(cursor.value)
        await tx.objectStore('sessionSummaries').put(summary)
        added.push(toSessionSummary(summary))
        if (!summary.temporary) {
          await touchSync(tx.objectStore('syncMeta'), SESSION_SYNC_PREFIX + summary.id)
        }
        for (const id of summary.fileIds) {
          fileIds.add(id)
        }
      }
      for (
        let cursor = await tx.objectStore('filesStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        if (fileIds.has(cursor.key) && (await files.count(cursor.key)) === 0) {
          await files.put(cursor.value)
        }
      }
      await tx.objectStore('sessionsStaging').clear()
      await tx.objectStore('filesStaging').clear()
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([merge(), tx.done])
  if (added.length > 0) {
    notifyLocalChange()
  }
  return { added, skipped }
}

export const loadMemoryDigests = async (): Promise<MemoryDigest[]> =>
  (await getDB()).getAll('memoryDigests')

export const saveMemoryDigest = async (digest: MemoryDigest): Promise<void> => {
  const tx = (await getDB()).transaction(['memoryDigests', 'syncMeta'], 'readwrite')
  await Promise.all([
    tx.objectStore('memoryDigests').put(digest),
    touchSync(tx.objectStore('syncMeta'), MEMORY_SYNC_KEY),
    tx.done,
  ])
  notifyLocalChange()
}

/** 用户删掉一条近期摘要：留下删除标记，同步时其他设备上的同一条摘要也删除 */
export const deleteMemoryDigest = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['memoryDigests', 'syncMeta'], 'readwrite')
  const meta = tx.objectStore('syncMeta')
  await Promise.all([
    tx.objectStore('memoryDigests').delete(sessionId),
    tombstoneSync(meta, MEMORY_DIGEST_SYNC_PREFIX + sessionId),
    touchSync(meta, MEMORY_SYNC_KEY),
    tx.done,
  ])
  notifyLocalChange()
}

export const loadMemoryProfile = async (): Promise<MemoryProfile | undefined> =>
  (await getDB()).get('memoryProfile', 'profile')

export const saveMemoryProfile = async (profile: MemoryProfile): Promise<void> => {
  const tx = (await getDB()).transaction(['memoryProfile', 'syncMeta'], 'readwrite')
  await Promise.all([
    tx.objectStore('memoryProfile').put(profile),
    touchSync(tx.objectStore('syncMeta'), MEMORY_SYNC_KEY),
    tx.done,
  ])
  notifyLocalChange()
}

/** 清空全部记忆：条目、近期摘要、元数据与活动记录；会话本身不受影响。 */
export const clearMemory = async (): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['memoryDigests', 'memoryProfile', 'memoryLog', 'memoryItems', 'syncMeta'],
    'readwrite'
  )
  const meta = tx.objectStore('syncMeta')
  await Promise.all([
    tx.objectStore('memoryDigests').clear(),
    tx.objectStore('memoryProfile').clear(),
    tx.objectStore('memoryLog').clear(),
    tx.objectStore('memoryItems').clear(),
    // 清空时间（见 memory/state.ts 的 readClearedAt）会带到其他设备，逐条的删除标记不再需要
    meta.delete(prefixRange(MEMORY_ITEM_SYNC_PREFIX)),
    meta.delete(prefixRange(MEMORY_DIGEST_SYNC_PREFIX)),
    touchSync(meta, MEMORY_SYNC_KEY),
    tx.done,
  ])
  notifyLocalChange()
}

export const loadMemoryItems = async (): Promise<MemoryItem[]> =>
  (await getDB()).getAll('memoryItems')

/** 一次记忆写入要落库的内容；省略的部分不动 */
export type MemoryPlan = {
  putItems?: MemoryItem[]
  deleteItems?: string[]
  profile?: MemoryProfile
  digests?: MemoryDigest[]
  log?: MemoryLogEntry
}

/**
 * 在一个事务里读取最新的记忆、计算并写入改动：条目、元数据、摘要和活动记录要么一起写入，要么都不写。
 * plan 必须是同步函数，在事务内执行；它基于事务里读到的数据决定写什么，返回 null 表示放弃。
 * 给了 sessionId 时先确认对话还在，已被删除就放弃，不会给已删除的对话留下摘要或记忆。
 * 返回实际写入的内容。
 */
export const commitMemory = async ({
  sessionId,
  logLimit,
  plan,
}: {
  sessionId?: string
  logLimit: number
  plan: (current: {
    items: MemoryItem[]
    profile: MemoryProfile | undefined
    digests: MemoryDigest[]
  }) => MemoryPlan | null
}): Promise<MemoryPlan | null> => {
  const tx = (await getDB()).transaction(
    ['sessionSummaries', 'memoryItems', 'memoryProfile', 'memoryDigests', 'memoryLog', 'syncMeta'],
    'readwrite'
  )
  const meta = tx.objectStore('syncMeta')
  const run = async (): Promise<MemoryPlan | null> => {
    try {
      if (sessionId !== undefined && !(await tx.objectStore('sessionSummaries').count(sessionId))) {
        return null
      }
      const [items, profile, digests] = await Promise.all([
        tx.objectStore('memoryItems').getAll(),
        tx.objectStore('memoryProfile').get('profile'),
        tx.objectStore('memoryDigests').getAll(),
      ])
      const result = plan({ items, profile, digests })
      if (!result) {
        return null
      }
      for (const item of result.putItems ?? []) {
        await tx.objectStore('memoryItems').put(item)
        // 撤销删除会把条目原样放回（updatedAt 不变）：把删除标记改成「放回时间」，同步时不会再被旧的删除带走
        if (await meta.count(MEMORY_ITEM_SYNC_PREFIX + item.id)) {
          await touchSync(meta, MEMORY_ITEM_SYNC_PREFIX + item.id)
        }
      }
      for (const id of result.deleteItems ?? []) {
        await tx.objectStore('memoryItems').delete(id)
        await tombstoneSync(meta, MEMORY_ITEM_SYNC_PREFIX + id)
      }
      if (result.profile) {
        await tx.objectStore('memoryProfile').put(result.profile)
      }
      for (const digest of result.digests ?? []) {
        await tx.objectStore('memoryDigests').put(digest)
      }
      if (result.log) {
        const log = tx.objectStore('memoryLog')
        await log.put(result.log)
        const stale = (await log.getAll()).sort((a, b) => b.at - a.at).slice(logLimit)
        for (const entry of stale) {
          await log.delete(entry.id)
        }
      }
      // 只追加活动记录不算记忆改动：活动记录不同步
      if (
        result.putItems?.length ||
        result.deleteItems?.length ||
        result.profile ||
        result.digests?.length
      ) {
        await touchSync(meta, MEMORY_SYNC_KEY)
        changed = true
      }
      return result
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  let changed = false
  const [result] = await Promise.all([run(), tx.done])
  if (changed) {
    notifyLocalChange()
  }
  return result
}

/**
 * 改动一条已保存的消息，不改会话的更新时间和列表元数据；对话或消息已不存在时返回 false。
 * 用于不在内存里的会话：在一个事务里读出、修改、写回，不会覆盖期间的其他写入，也不会让已删除的对话复活。
 */
export const patchSessionMessage = async (
  sessionId: string,
  messageId: string,
  update: (message: Message) => Message
): Promise<boolean> => {
  const tx = (await getDB()).transaction(['sessions', 'syncMeta'], 'readwrite')
  const run = async () => {
    try {
      const sessions = tx.objectStore('sessions')
      const session = await sessions.get(sessionId)
      if (!session?.messages.some((message) => message.id === messageId)) {
        return false
      }
      await sessions.put({
        ...session,
        messages: session.messages.map((message) =>
          message.id === messageId ? update(message) : message
        ),
      })
      if (!session.temporary) {
        await touchSync(tx.objectStore('syncMeta'), SESSION_SYNC_PREFIX + sessionId)
      }
      return true
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  const [patched] = await Promise.all([run(), tx.done])
  if (patched) {
    notifyLocalChange()
  }
  return patched
}

/** 删除某个会话的全部活动记录；记录只保留几十条，逐条游标即可。 */
const deleteLogEntries = async (
  store: IDBPObjectStore<ChatDB, ArrayLike<StoreNames<ChatDB>>, 'memoryLog', 'readwrite'>,
  sessionId: string
) => {
  for (let cursor = await store.openCursor(); cursor; cursor = await cursor.continue()) {
    if (cursor.value.sessionId === sessionId) {
      await cursor.delete()
    }
  }
}

export const loadMemoryLog = async (): Promise<MemoryLogEntry[]> =>
  (await getDB()).getAll('memoryLog')

/** 追加一条活动记录，并删除超出上限的最早记录 */
export const addMemoryLogEntry = async (entry: MemoryLogEntry, limit: number): Promise<void> => {
  const tx = (await getDB()).transaction('memoryLog', 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await tx.store.put(entry)
        const all = await tx.store.getAll()
        const stale = all.sort((a, b) => b.at - a.at).slice(limit)
        for (const item of stale) {
          await tx.store.delete(item.id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除一条近期对话摘要时，它的摘要记录也一并删除 */
export const deleteMemoryLogForSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction('memoryLog', 'readwrite')
  await Promise.all([deleteLogEntries(tx.store, sessionId), tx.done])
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

// ---- 同步专用读写：写回远端数据时不产生本地改动标记，也不通知 onLocalChange ----

/** 写回时附带的同步状态 */
export type SyncWrite = {
  /** 规划同步时看到的本地改动时间；写入前在事务里再核对一次，期间本地又改了就放弃 */
  expect: number | undefined
  /** 写入后的改动时间 */
  modifiedAt: number
  /** 给了表示内容与远端这个版本一致（已同步）；没给表示是合并结果，还要上传 */
  rev?: string
}

const syncedMeta = (key: string, previous: SyncMeta | undefined, sync: SyncWrite): SyncMeta =>
  sync.rev === undefined
    ? { key, modifiedAt: sync.modifiedAt, ...syncBaseline(previous) }
    : { key, modifiedAt: sync.modifiedAt, syncedAt: sync.modifiedAt, syncedRev: sync.rev }

export const loadSyncMeta = async (prefix: string): Promise<SyncMeta[]> =>
  (await getDB()).getAll('syncMeta', prefixRange(prefix))

export const getSyncMeta = async (key: string): Promise<SyncMeta | undefined> =>
  (await getDB()).get('syncMeta', key)

/**
 * 记下一次成功的同步：modifiedAt 是上传（或下载）的那份内容的改动时间。
 * 同步期间本地又改了的话，条目的 modifiedAt 已经更大，下一轮仍会被当作有改动。
 */
export const markSynced = async (key: string, rev: string, modifiedAt: number): Promise<void> => {
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  const meta = await tx.store.get(key)
  await Promise.all([
    tx.store.put({ ...(meta ?? { key, modifiedAt }), syncedAt: modifiedAt, syncedRev: rev }),
    tx.done,
  ])
}

/** 删除已经带到远端后，本地的删除标记不再需要；期间条目又被改动（恢复）时保留 */
export const dropSyncTombstone = async (key: string, deletedAt: number): Promise<void> => {
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  const meta = await tx.store.get(key)
  await Promise.all([meta?.deletedAt === deletedAt ? tx.store.delete(key) : undefined, tx.done])
}

/** 换了同步服务商或账号：丢掉指定前缀下的全部基线，下一轮按首次同步处理；改动时间和删除标记保留 */
export const resetSyncBaselines = async (prefix: string): Promise<void> => {
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  await Promise.all([
    (async () => {
      for (
        let cursor = await tx.store.openCursor(prefixRange(prefix));
        cursor;
        cursor = await cursor.continue()
      ) {
        const { key, modifiedAt, deletedAt } = cursor.value
        await cursor.update({ key, modifiedAt, ...(deletedAt === undefined ? {} : { deletedAt }) })
      }
    })(),
    tx.done,
  ])
}

/** 丢掉一个会话的同步基线：下一轮同步把它当作两边都改过，与远端重新合并 */
export const markSyncConflict = async (sessionId: string): Promise<void> => {
  const key = SESSION_SYNC_PREFIX + sessionId
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  const meta = await tx.store.get(key)
  await Promise.all([
    meta ? tx.store.put({ key, modifiedAt: nextModifiedAt(meta.modifiedAt) }) : undefined,
    tx.done,
  ])
  notifyLocalChange()
}

/** 从未同步出去、又放了很久的删除标记不再保留 */
export const pruneSyncTombstones = async (before: number): Promise<void> => {
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        if (cursor.value.deletedAt !== undefined && cursor.value.deletedAt < before) {
          await cursor.delete()
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 写回一个来自远端（或合并后）的会话；本地在规划之后又改动过时返回 null，什么都不写。
 * 新版本不再引用的原件一并清理。
 */
export const applySyncedSession = async (
  session: Session,
  sync: SyncWrite
): Promise<SessionSummary | null> => {
  const key = SESSION_SYNC_PREFIX + session.id
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncMeta'],
    'readwrite'
  )
  const run = async () => {
    try {
      const summaries = tx.objectStore('sessionSummaries')
      const [meta, previous] = await Promise.all([
        tx.objectStore('syncMeta').get(key),
        summaries.get(session.id),
      ])
      if ((meta?.modifiedAt ?? previous?.updatedAt) !== sync.expect) {
        return null
      }
      await tx.objectStore('sessions').put(session)
      await summaries.put(summary)
      for (const id of previous?.fileIds ?? []) {
        if ((await summaries.index('fileIds').count(id)) === 0) {
          await tx.objectStore('files').delete(id)
        }
      }
      await tx.objectStore('syncMeta').put(syncedMeta(key, meta, sync))
      return toSessionSummary(summary)
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  const [result] = await Promise.all([run(), tx.done])
  return result
}

/** 远端已删除的会话在本地删除，不留删除标记；本地在规划之后又改动过时返回 false。 */
export const removeSyncedSession = async (
  sessionId: string,
  expect: number | undefined
): Promise<boolean> => {
  const key = SESSION_SYNC_PREFIX + sessionId
  const tx = (await getDB()).transaction(SESSION_REMOVAL_STORES, 'readwrite')
  const run = async () => {
    try {
      const [meta, previous] = await Promise.all([
        tx.objectStore('syncMeta').get(key),
        tx.objectStore('sessionSummaries').get(sessionId),
      ])
      if ((meta?.modifiedAt ?? previous?.updatedAt) !== expect) {
        return false
      }
      await removeSessionRecords(tx, sessionId)
      await tx.objectStore('syncMeta').delete(key)
      return true
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  const [removed] = await Promise.all([run(), tx.done])
  return removed
}

/** 记忆的可同步部分；活动记录只留在本机 */
export type MemorySyncState = {
  items: MemoryItem[]
  profile: MemoryProfile | null
  digests: MemoryDigest[]
  /** 已删除的条目：id → 删除时间 */
  deletedItems: Record<string, number>
  /** 删除后又放回的条目：id → 放回时间 */
  revivedItems: Record<string, number>
  /** 用户删掉的近期摘要：会话 id → 删除时间 */
  deletedDigests: Record<string, number>
}

/** 还没有同步元数据的旧数据按「有改动」处理 */
const memoryModifiedAt = (meta: SyncMeta | undefined, hasData: boolean) =>
  meta?.modifiedAt ?? (hasData ? 1 : undefined)

export const loadMemoryForSync = async (): Promise<{
  state: MemorySyncState
  modifiedAt: number | undefined
  meta: SyncMeta | undefined
}> => {
  const tx = (await getDB()).transaction(
    ['memoryItems', 'memoryProfile', 'memoryDigests', 'syncMeta'],
    'readonly'
  )
  const metaStore = tx.objectStore('syncMeta')
  const [items, profile, digests, itemMarks, digestMarks, meta] = await Promise.all([
    tx.objectStore('memoryItems').getAll(),
    tx.objectStore('memoryProfile').get('profile'),
    tx.objectStore('memoryDigests').getAll(),
    metaStore.getAll(prefixRange(MEMORY_ITEM_SYNC_PREFIX)),
    metaStore.getAll(prefixRange(MEMORY_DIGEST_SYNC_PREFIX)),
    metaStore.get(MEMORY_SYNC_KEY),
  ])
  const marks = (list: SyncMeta[], prefix: string, deleted: boolean) =>
    Object.fromEntries(
      list
        .filter((mark) => (mark.deletedAt !== undefined) === deleted)
        .map((mark) => [mark.key.slice(prefix.length), mark.deletedAt ?? mark.modifiedAt])
    )
  return {
    state: {
      items,
      profile: profile ?? null,
      digests,
      deletedItems: marks(itemMarks, MEMORY_ITEM_SYNC_PREFIX, true),
      revivedItems: marks(itemMarks, MEMORY_ITEM_SYNC_PREFIX, false),
      deletedDigests: marks(digestMarks, MEMORY_DIGEST_SYNC_PREFIX, true),
    },
    modifiedAt: memoryModifiedAt(meta, items.length > 0 || digests.length > 0 || Boolean(profile)),
    meta,
  }
}

/**
 * 用远端（或合并后）的记忆整体替换本地的条目、元数据、摘要和删除标记；活动记录不动。
 * 对话已不在本地的摘要不写入。本地在规划之后又改动过时返回 false，什么都不写。
 */
export const applySyncedMemory = async (
  state: MemorySyncState,
  sync: SyncWrite
): Promise<boolean> => {
  const tx = (await getDB()).transaction(
    ['sessionSummaries', 'memoryItems', 'memoryProfile', 'memoryDigests', 'syncMeta'],
    'readwrite'
  )
  const run = async () => {
    try {
      const metaStore = tx.objectStore('syncMeta')
      const items = tx.objectStore('memoryItems')
      const digests = tx.objectStore('memoryDigests')
      const profiles = tx.objectStore('memoryProfile')
      const [meta, itemCount, digestCount, profileCount] = await Promise.all([
        metaStore.get(MEMORY_SYNC_KEY),
        items.count(),
        digests.count(),
        profiles.count(),
      ])
      if (memoryModifiedAt(meta, itemCount + digestCount + profileCount > 0) !== sync.expect) {
        return false
      }
      await items.clear()
      for (const item of state.items) {
        await items.put(item)
      }
      if (state.profile) {
        await profiles.put(state.profile)
      } else {
        await profiles.clear()
      }
      await digests.clear()
      for (const digest of state.digests) {
        if (await tx.objectStore('sessionSummaries').count(digest.sessionId)) {
          await digests.put(digest)
        }
      }
      await metaStore.delete(prefixRange(MEMORY_ITEM_SYNC_PREFIX))
      await metaStore.delete(prefixRange(MEMORY_DIGEST_SYNC_PREFIX))
      for (const [id, at] of Object.entries(state.deletedItems)) {
        await metaStore.put({ key: MEMORY_ITEM_SYNC_PREFIX + id, modifiedAt: at, deletedAt: at })
      }
      for (const [id, at] of Object.entries(state.revivedItems)) {
        if (!(id in state.deletedItems) || state.deletedItems[id] < at) {
          await metaStore.put({ key: MEMORY_ITEM_SYNC_PREFIX + id, modifiedAt: at })
        }
      }
      for (const [id, at] of Object.entries(state.deletedDigests)) {
        await metaStore.put({ key: MEMORY_DIGEST_SYNC_PREFIX + id, modifiedAt: at, deletedAt: at })
      }
      await metaStore.put(syncedMeta(MEMORY_SYNC_KEY, meta, sync))
      return true
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  const [applied] = await Promise.all([run(), tx.done])
  return applied
}
