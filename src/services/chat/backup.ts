import { formatDate } from '../../utils/format.js'
import { exportMemory, importMemory, type MemoryExport } from '../memory/items.js'
import { initMemory } from '../memory/store.js'
import * as db from './db.js'
import { mergeHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。记忆（已生效的条目和不再提及的话题）写在 manifest 里。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 记忆启动时已读取，这里只确保读取完成；和会话列表一样取导出开始时的快照。
    await initMemory()
    const memory = exportMemory()
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), memory)
    return { name: backupFileName(now), blob }
  })

export type ImportResult = {
  /** 新增的会话数 */
  added: number
  /** 本地已存在而跳过的会话数 */
  skipped: number
  /** 新增的记忆条数；归档里没有记忆，或记忆导入失败时为 null */
  memoryAdded: number | null
  /** 会话已导入，但记忆导入失败 */
  memoryFailed: boolean
}

/**
 * 确认导入后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才合并进本地：只添加本地没有的会话，已有会话不变。
 * 会话合并完成后再合并归档里的记忆（重复的跳过）；记忆导入失败单独报告，不算整次导入失败。
 */
export const importHistory = (file: File): Promise<ImportResult> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    const archive: { memory: MemoryExport | null } = { memory: null }
    const { added, skipped } = await mergeHistory(async () => {
      archive.memory = await importArchive(file)
    })
    if (!archive.memory) {
      return { added, skipped, memoryAdded: null, memoryFailed: false }
    }
    try {
      const memoryAdded = await importMemory(archive.memory)
      return { added, skipped, memoryAdded, memoryFailed: false }
    } catch (error) {
      db.reportStorageError('import memory')(error)
      return { added, skipped, memoryAdded: null, memoryFailed: true }
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
