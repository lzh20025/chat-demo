import { describe, expect, it } from 'vitest'
import { SyncAuthError, type SyncBackend } from '../backend.js'
import type { LocalEntry, SyncCollection } from '../collection.js'
import { fileName, runSync, tombstoneFileName } from '../engine.js'

/** 内存版后端：引擎只依赖 SyncBackend 接口，不需要任何真实服务 */
const createMemoryBackend = () => {
  const files = new Map<string, { text: string; rev: string }>()
  let counter = 0
  const backend: SyncBackend = {
    list: async () => [...files].map(([name, file]) => ({ name, rev: file.rev })),
    read: async (name) => {
      const file = files.get(name)
      if (!file) {
        throw new Error(`missing ${name}`)
      }
      return file.text
    },
    stat: async (name) => {
      const file = files.get(name)
      return file ? { name, rev: file.rev } : null
    },
    write: async (name, text) => {
      counter += 1
      const rev = `rev${counter}`
      files.set(name, { text, rev })
      return { name, rev }
    },
    remove: async (name) => {
      files.delete(name)
    },
  }
  return { backend, files }
}

/** 测试里的时间戳都很小，用固定的「现在」避免删除记录被当成过期 */
const now = () => 10_000

type Note = { text: string[] }

/** 一台「设备」：一个最简单的数据种类，内容是字符串列表，合并取并集 */
const createDevice = () => {
  const notes = new Map<string, Note>()
  const meta = new Map<string, LocalEntry>()
  let clock = 0
  const tick = () => (clock += 1)
  const touch = (key: string) => {
    const previous = meta.get(key)
    meta.set(key, {
      key,
      // 与真实实现一致：同一条目的改动时间严格递增
      modifiedAt: Math.max(tick() + 1000, (previous?.modifiedAt ?? 0) + 1),
      syncedAt: previous?.syncedAt,
      syncedRev: previous?.syncedRev,
    })
  }
  const collection: SyncCollection<Note> = {
    id: 'notes',
    ready: () => true,
    listLocal: async () => [...meta.values()],
    read: async (key) => notes.get(key) ?? null,
    parse: (data) =>
      typeof data === 'object' && data !== null && Array.isArray((data as Note).text)
        ? (data as Note)
        : null,
    write: async (key, data, sync) => {
      if (meta.get(key)?.modifiedAt !== sync.expect) {
        return 'deferred'
      }
      notes.set(key, data)
      const previous = meta.get(key)
      meta.set(
        key,
        sync.rev === undefined
          ? {
              key,
              modifiedAt: sync.modifiedAt,
              syncedAt: previous?.syncedAt,
              syncedRev: previous?.syncedRev,
            }
          : { key, modifiedAt: sync.modifiedAt, syncedAt: sync.modifiedAt, syncedRev: sync.rev }
      )
      return 'applied'
    },
    remove: async (key, expect) => {
      if (meta.get(key)?.modifiedAt !== expect) {
        return 'deferred'
      }
      notes.delete(key)
      meta.delete(key)
      return 'applied'
    },
    merge: (local, remote) => ({ text: [...new Set([...local.text, ...remote.text])].sort() }),
    markSynced: async (key, rev, modifiedAt) => {
      const previous = meta.get(key)
      meta.set(key, { ...(previous ?? { key, modifiedAt }), syncedAt: modifiedAt, syncedRev: rev })
    },
    forget: async (key, deletedAt) => {
      if (meta.get(key)?.deletedAt === deletedAt) {
        meta.delete(key)
      }
    },
    resetBaselines: async () => {
      for (const [key, entry] of meta) {
        meta.set(key, { key, modifiedAt: entry.modifiedAt, deletedAt: entry.deletedAt })
      }
    },
  }
  return {
    collection,
    notes,
    meta,
    put(key: string, text: string[]) {
      notes.set(key, { text })
      touch(key)
    },
    delete(key: string) {
      notes.delete(key)
      const previous = meta.get(key)
      const at = Math.max(tick() + 1000, (previous?.modifiedAt ?? 0) + 1)
      meta.set(key, {
        key,
        modifiedAt: at,
        deletedAt: at,
        syncedAt: previous?.syncedAt,
        syncedRev: previous?.syncedRev,
      })
    },
  }
}

describe('runSync', () => {
  it('uploads from one device and restores on a fresh one', async () => {
    const { backend, files } = createMemoryBackend()
    const a = createDevice()
    a.put('x', ['hello'])
    expect(await runSync(backend, [a.collection], now)).toMatchObject({ uploaded: 1, failed: 0 })
    expect(files.has(fileName('notes', 'x'))).toBe(true)

    const b = createDevice()
    expect(await runSync(backend, [b.collection], now)).toMatchObject({ downloaded: 1, failed: 0 })
    expect(b.notes.get('x')).toEqual({ text: ['hello'] })
    // 再跑一轮什么都不用做
    expect(await runSync(backend, [b.collection], now)).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      merged: 0,
    })
  })

  it('merges when both devices changed the same entry, losing nothing', async () => {
    const { backend } = createMemoryBackend()
    const a = createDevice()
    const b = createDevice()
    a.put('x', ['base'])
    await runSync(backend, [a.collection], now)
    await runSync(backend, [b.collection], now)

    a.put('x', ['base', 'from-a'])
    b.put('x', ['base', 'from-b'])
    await runSync(backend, [a.collection], now)
    expect(await runSync(backend, [b.collection], now)).toMatchObject({ merged: 1, failed: 0 })
    expect(b.notes.get('x')).toEqual({ text: ['base', 'from-a', 'from-b'] })

    expect(await runSync(backend, [a.collection], now)).toMatchObject({ downloaded: 1 })
    expect(a.notes.get('x')).toEqual({ text: ['base', 'from-a', 'from-b'] })
  })

  it('propagates deletions through tombstones', async () => {
    const { backend, files } = createMemoryBackend()
    const a = createDevice()
    const b = createDevice()
    a.put('x', ['one'])
    await runSync(backend, [a.collection], now)
    await runSync(backend, [b.collection], now)

    a.delete('x')
    expect(await runSync(backend, [a.collection], now)).toMatchObject({ deleted: 1 })
    expect(files.has(fileName('notes', 'x'))).toBe(false)
    expect(JSON.parse(files.get(tombstoneFileName('notes'))?.text ?? '{}').deleted).toHaveProperty(
      'x'
    )
    expect(a.meta.has('x')).toBe(false)

    expect(await runSync(backend, [b.collection], now)).toMatchObject({ deleted: 1 })
    expect(b.notes.has('x')).toBe(false)
  })

  it('keeps an entry that was edited on another device after being deleted here', async () => {
    const { backend } = createMemoryBackend()
    const a = createDevice()
    const b = createDevice()
    a.put('x', ['one'])
    await runSync(backend, [a.collection], now)
    await runSync(backend, [b.collection], now)

    a.delete('x')
    // b 在 a 删除之后继续编辑并先同步
    b.put('x', ['one', 'two'])
    b.meta.set('x', { ...b.meta.get('x'), key: 'x', modifiedAt: 9000 })
    await runSync(backend, [b.collection], now)

    expect(await runSync(backend, [a.collection], now)).toMatchObject({ downloaded: 1, deleted: 0 })
    expect(a.notes.get('x')).toEqual({ text: ['one', 'two'] })
  })

  it('skips an upload when the remote changed after planning', async () => {
    const { backend, files } = createMemoryBackend()
    const a = createDevice()
    a.put('x', ['one'])
    await runSync(backend, [a.collection], now)
    a.put('x', ['one', 'two'])

    // 另一台设备在 list 之后、上传之前写入了新版本
    const racing: SyncBackend = {
      ...backend,
      list: async () => {
        const entries = await backend.list()
        await backend.write(
          fileName('notes', 'x'),
          JSON.stringify({ v: 1, modifiedAt: 1, data: { text: ['other'] } })
        )
        return entries
      },
    }
    expect(await runSync(racing, [a.collection], now)).toMatchObject({ uploaded: 0, deferred: 1 })
    expect(JSON.parse(files.get(fileName('notes', 'x'))?.text ?? '{}').data).toEqual({
      text: ['other'],
    })

    // 下一轮按冲突合并
    expect(await runSync(backend, [a.collection], now)).toMatchObject({ merged: 1 })
    expect(a.notes.get('x')).toEqual({ text: ['one', 'other', 'two'] })
  })

  it('does not write back remote data the collection cannot parse', async () => {
    const { backend } = createMemoryBackend()
    await backend.write(fileName('notes', 'bad'), JSON.stringify({ v: 1, modifiedAt: 1, data: 42 }))
    await backend.write(fileName('notes', 'future'), JSON.stringify({ v: 99, modifiedAt: 1 }))
    const a = createDevice()
    expect(await runSync(backend, [a.collection], now)).toMatchObject({ downloaded: 0, failed: 2 })
    expect(a.notes.size).toBe(0)
  })

  it('skips collections that are not ready and stops on auth errors', async () => {
    const { backend } = createMemoryBackend()
    const a = createDevice()
    a.put('x', ['one'])
    expect(await runSync(backend, [{ ...a.collection, ready: () => false }], now)).toMatchObject({
      uploaded: 0,
      deferred: 1,
    })

    const unauthorized: SyncBackend = {
      ...backend,
      write: async () => {
        throw new SyncAuthError()
      },
    }
    await expect(runSync(unauthorized, [a.collection], now)).rejects.toBeInstanceOf(SyncAuthError)
  })
})
