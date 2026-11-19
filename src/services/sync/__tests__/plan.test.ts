import { describe, expect, it } from 'vitest'
import { planSync } from '../plan.js'

const remote = (entries: Record<string, string>) => new Map(Object.entries(entries))

describe('planSync', () => {
  it('uploads entries that were never synced', () => {
    expect(planSync([{ key: 'a', modifiedAt: 5 }], remote({}), {})).toEqual([
      { type: 'upload', key: 'a', local: { key: 'a', modifiedAt: 5 } },
    ])
  })

  it('does nothing when neither side changed', () => {
    const local = [{ key: 'a', modifiedAt: 5, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({ a: 'r1' }), {})).toEqual([])
  })

  it('uploads local changes when the remote is unchanged', () => {
    const local = [{ key: 'a', modifiedAt: 9, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({ a: 'r1' }), {})).toEqual([
      { type: 'upload', key: 'a', local: local[0], remoteRev: 'r1' },
    ])
  })

  it('downloads remote changes when local is unchanged', () => {
    const local = [{ key: 'a', modifiedAt: 5, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({ a: 'r2' }), {})).toEqual([
      { type: 'download', key: 'a', local: local[0], remoteRev: 'r2' },
    ])
  })

  it('reports a conflict when both sides changed', () => {
    const local = [{ key: 'a', modifiedAt: 9, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({ a: 'r2' }), {})).toEqual([
      { type: 'conflict', key: 'a', local: local[0], remoteRev: 'r2' },
    ])
  })

  it('treats an unsynced local entry that already exists remotely as a conflict', () => {
    const local = [{ key: 'a', modifiedAt: 9 }]
    expect(planSync(local, remote({ a: 'r1' }), {})[0].type).toBe('conflict')
  })

  it('downloads entries that only exist remotely', () => {
    expect(planSync([], remote({ b: 'r1' }), {})).toEqual([
      { type: 'download', key: 'b', remoteRev: 'r1' },
    ])
  })

  it('deletes locally when another device deleted it after the last local change', () => {
    const local = [{ key: 'a', modifiedAt: 5, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({}), { a: 8 })).toEqual([
      { type: 'deleteLocal', key: 'a', local: local[0] },
    ])
  })

  it('keeps and re-uploads an entry edited after it was deleted elsewhere', () => {
    const local = [{ key: 'a', modifiedAt: 12, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({}), { a: 8 })).toEqual([
      { type: 'upload', key: 'a', local: local[0], clearTombstone: true },
    ])
  })

  it('re-uploads rather than deletes when the remote file vanished without a tombstone', () => {
    const local = [{ key: 'a', modifiedAt: 5, syncedAt: 5, syncedRev: 'r1' }]
    expect(planSync(local, remote({}), {})[0].type).toBe('upload')
  })

  it('deletes remotely when the local deletion is the only change', () => {
    const local = [{ key: 'a', modifiedAt: 9, syncedAt: 5, syncedRev: 'r1', deletedAt: 9 }]
    expect(planSync(local, remote({ a: 'r1' }), {})).toEqual([
      { type: 'deleteRemote', key: 'a', local: local[0], remoteRev: 'r1' },
    ])
  })

  it('checks timestamps when a locally deleted entry also changed remotely', () => {
    const local = [{ key: 'a', modifiedAt: 9, syncedAt: 5, syncedRev: 'r1', deletedAt: 9 }]
    expect(planSync(local, remote({ a: 'r2' }), {})[0].type).toBe('deleteConflict')
  })

  it('only records a tombstone for deletions that had been synced', () => {
    const synced = { key: 'a', modifiedAt: 9, syncedAt: 5, syncedRev: 'r1', deletedAt: 9 }
    const unsynced = { key: 'b', modifiedAt: 9, deletedAt: 9 }
    expect(planSync([synced, unsynced], remote({}), {})).toEqual([
      { type: 'forget', key: 'a', local: synced, addTombstone: true },
      { type: 'forget', key: 'b', local: unsynced, addTombstone: false },
    ])
  })
})
