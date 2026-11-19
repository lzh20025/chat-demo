import { describe, expect, it } from 'vitest'
import type { MemoryDigest, MemoryProfile } from '../../chat/db.js'
import type { MemoryItem } from '../../chat/types.js'
import { mergeMemory, type MemorySyncData } from '../collections/memoryMerge.js'

const item = (id: string, updatedAt: number, text = id): MemoryItem => ({
  id,
  text,
  category: 'other',
  origin: 'auto',
  status: 'saved',
  sources: [],
  createdAt: updatedAt,
  updatedAt,
})

const digest = (sessionId: string, digestedAt: number, summary = sessionId): MemoryDigest => ({
  sessionId,
  title: sessionId,
  summary,
  updatedAt: digestedAt,
  digestedAt,
  messageCount: 2,
})

const data = (patch: Partial<MemorySyncData> = {}): MemorySyncData => ({
  items: [],
  profile: null,
  digests: [],
  deletedItems: {},
  revivedItems: {},
  deletedDigests: {},
  clearedAt: 0,
  ...patch,
})

const itemIds = (memory: MemorySyncData) => memory.items.map((entry) => entry.id)

describe('mergeMemory', () => {
  it('unions items and keeps the newer version of the same item', () => {
    const merged = mergeMemory(
      data({ items: [item('a', 10, 'old'), item('b', 5)] }),
      data({ items: [item('a', 20, 'new'), item('c', 7)] })
    )
    expect(itemIds(merged)).toEqual(['b', 'c', 'a'])
    expect(merged.items.find((entry) => entry.id === 'a')?.text).toBe('new')
  })

  it('applies a deletion made after the item last changed', () => {
    const merged = mergeMemory(data({ items: [item('a', 10)] }), data({ deletedItems: { a: 15 } }))
    expect(itemIds(merged)).toEqual([])
    expect(merged.deletedItems).toEqual({ a: 15 })
  })

  it('keeps an item edited after it was deleted elsewhere', () => {
    const merged = mergeMemory(data({ items: [item('a', 20)] }), data({ deletedItems: { a: 15 } }))
    expect(itemIds(merged)).toEqual(['a'])
  })

  it('keeps an item restored by undo even though its updatedAt predates the deletion', () => {
    const merged = mergeMemory(
      data({ items: [item('a', 10)], revivedItems: { a: 18 } }),
      data({ deletedItems: { a: 15 } })
    )
    expect(itemIds(merged)).toEqual(['a'])
    expect(merged.revivedItems).toEqual({ a: 18 })
  })

  it('drops everything from before a clear on either device', () => {
    const merged = mergeMemory(
      data({
        items: [item('old', 10), item('new', 60)],
        digests: [digest('s1', 10), digest('s2', 60)],
        deletedItems: { gone: 20 },
      }),
      data({ clearedAt: 50 })
    )
    expect(itemIds(merged)).toEqual(['new'])
    expect(merged.digests.map((entry) => entry.sessionId)).toEqual(['s2'])
    expect(merged.deletedItems).toEqual({})
    expect(merged.clearedAt).toBe(50)
  })

  it('keeps one copy of the same fact recorded on two devices', () => {
    const merged = mergeMemory(
      data({ items: [item('a', 10, 'Lives in Berlin')] }),
      data({ items: [item('b', 12, ' lives in berlin ')] })
    )
    expect(itemIds(merged)).toEqual(['a'])
  })

  it('merges digests per session and honours digest deletions', () => {
    const merged = mergeMemory(
      data({ digests: [digest('s1', 10, 'old'), digest('s2', 10)] }),
      data({ digests: [digest('s1', 20, 'new')], deletedDigests: { s2: 15 } })
    )
    expect(merged.digests).toEqual([digest('s1', 20, 'new')])
  })

  it('unions muted and forgotten lists in the profile', () => {
    const profile = (patch: Partial<MemoryProfile>): MemoryProfile => ({
      id: 'profile',
      content: '',
      updatedAt: 1,
      dreamedAt: 1,
      ...patch,
    })
    const merged = mergeMemory(
      data({
        profile: profile({ updatedAt: 5, muted: ['work'], forgotten: [{ text: 'x', at: 1 }] }),
      }),
      data({
        profile: profile({ dreamedAt: 9, muted: ['family'], forgotten: [{ text: 'X', at: 4 }] }),
      })
    )
    expect(merged.profile).toMatchObject({
      updatedAt: 5,
      dreamedAt: 9,
      muted: ['work', 'family'],
      forgotten: [{ text: 'X', at: 4 }],
    })
  })

  it('is stable: merging the result with either input changes nothing', () => {
    const local = data({ items: [item('a', 10), item('b', 30)], deletedItems: { c: 5 } })
    const remote = data({ items: [item('a', 20), item('c', 3)], digests: [digest('s', 4)] })
    const merged = mergeMemory(local, remote)
    expect(mergeMemory(merged, remote)).toEqual(merged)
    expect(mergeMemory(local, merged)).toEqual(merged)
  })
})
