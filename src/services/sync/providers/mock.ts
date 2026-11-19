import { openDB } from 'idb'
import type { SyncBackend } from '../backend.js'
import type { SyncProvider } from '../provider.js'

/**
 * 本地模拟后端：把「远端」文件存在本机一个独立的 IndexedDB 里，不需要登录，也不发任何网络请求。
 * 只在开发构建里注册，用来不依赖 Google 账号验证整套同步流程：
 * 清空应用自己的数据库再同步，相当于在一台新设备上从云端恢复。
 */

type MockFile = { name: string; text: string; rev: string }

const open = () =>
  openDB<{ files: { key: string; value: MockFile } }>('chat-demo-sync-mock', 1, {
    upgrade(db) {
      db.createObjectStore('files', { keyPath: 'name' })
    },
  })

const createMockBackend = (): SyncBackend => ({
  async list() {
    return (await (await open()).getAll('files')).map(({ name, rev }) => ({ name, rev }))
  },
  async read(name) {
    const file = await (await open()).get('files', name)
    if (!file) {
      throw new Error(`Sync file not found: ${name}`)
    }
    return file.text
  },
  async stat(name) {
    const file = await (await open()).get('files', name)
    return file ? { name, rev: file.rev } : null
  },
  async write(name, text) {
    const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await (await open()).put('files', { name, text, rev })
    return { name, rev }
  },
  async remove(name) {
    await (await open()).delete('files', name)
  },
})

export const mockProvider: SyncProvider = {
  id: 'mock',
  label: 'syncProviderMock',
  devOnly: true,
  auth: null,
  createBackend: createMockBackend,
}
