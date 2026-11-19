import { describe, expect, it } from 'vitest'
import { appendBranch, getVisibleMessages } from '../../chat/branches.js'
import type { AssistantMessage, Session, UserMessage } from '../../chat/types.js'
import { mergeSessions } from '../collections/sessionMerge.js'

const user = (id: string, createdAt: number, extra: Partial<UserMessage> = {}): UserMessage => ({
  id,
  role: 'user',
  content: id,
  files: [],
  createdAt,
  ...extra,
})

const reply = (
  id: string,
  createdAt: number,
  extra: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: id }],
  ...extra,
})

const base: Session = appendBranch(
  { id: 's', title: 'Base', createdAt: 1, updatedAt: 2, messages: [], rootMessageId: null },
  null,
  [user('u1', 1), reply('a1', 2)]
)

const ids = (session: Session) => session.messages.map((message) => message.id).sort()
const visible = (session: Session) => getVisibleMessages(session).map((message) => message.id)

describe('mergeSessions', () => {
  it('keeps both devices’ new turns as sibling branches', () => {
    const local = {
      ...appendBranch(base, 'a1', [user('u2-local', 3), reply('a2-local', 4)]),
      updatedAt: 4,
    }
    const remote = {
      ...appendBranch(base, 'a1', [user('u2-remote', 5), reply('a2-remote', 6)]),
      updatedAt: 6,
      title: 'Renamed remotely',
    }
    const merged = mergeSessions(local, remote, { localModifiedAt: 10, remoteModifiedAt: 20 })

    expect(ids(merged)).toEqual(['a1', 'a2-local', 'a2-remote', 'u1', 'u2-local', 'u2-remote'])
    // 最近改动的一方（远端）的分支和标题生效，另一条分支仍在
    expect(visible(merged)).toEqual(['u1', 'a1', 'u2-remote', 'a2-remote'])
    expect(merged.title).toBe('Renamed remotely')
    expect(merged.updatedAt).toBe(6)
    const siblings = merged.messages.filter((message) => message.parentId === 'a1')
    expect(siblings.map((message) => message.id)).toEqual(['u2-remote', 'u2-local'])
  })

  it('gives the same messages whichever side merges', () => {
    const local = appendBranch(base, 'a1', [user('u2-local', 3)])
    const remote = appendBranch(base, 'a1', [user('u2-remote', 5)])
    const times = { localModifiedAt: 10, remoteModifiedAt: 20 }
    const fromLocal = mergeSessions(local, remote, times)
    const fromRemote = mergeSessions(remote, local, {
      localModifiedAt: times.remoteModifiedAt,
      remoteModifiedAt: times.localModifiedAt,
    })
    expect(fromRemote).toEqual(fromLocal)
  })

  it('shows content added on the older side when the newer side has nothing after that message', () => {
    const local = appendBranch(base, 'a1', [user('u2', 3), reply('a2', 4)])
    // 远端只是改了标题，时间更新
    const remote = { ...base, title: 'New title' }
    const merged = mergeSessions(local, remote, { localModifiedAt: 10, remoteModifiedAt: 20 })
    expect(merged.title).toBe('New title')
    expect(visible(merged)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('prefers the finished version of a reply over an interrupted one', () => {
    const interrupted: Session = {
      ...base,
      messages: base.messages.map((message) =>
        message.id === 'a1'
          ? reply('a1', 2, { status: 'stopped', blocks: [], parentId: 'u1' })
          : message
      ),
    }
    const merged = mergeSessions(interrupted, base, { localModifiedAt: 20, remoteModifiedAt: 10 })
    const a1 = merged.messages.find((message) => message.id === 'a1') as AssistantMessage
    expect(a1.status).toBe('done')
    expect(a1.blocks).toHaveLength(1)
    expect(a1.parentId).toBe('u1')
  })

  it('unions memory changes attached to the same question', () => {
    const change = (itemId: string) => ({ kind: 'added' as const, itemId, text: itemId, at: 1 })
    const withChange = (itemId: string): Session => ({
      ...base,
      messages: base.messages.map((message) =>
        message.id === 'u1' ? { ...message, memoryChanges: [change(itemId)] } : message
      ),
    })
    const merged = mergeSessions(withChange('m1'), withChange('m2'), {
      localModifiedAt: 20,
      remoteModifiedAt: 10,
    })
    const u1 = merged.messages.find((message) => message.id === 'u1') as UserMessage
    expect(u1.memoryChanges?.map((item) => 'itemId' in item && item.itemId)).toEqual(['m1', 'm2'])
  })

  it('merges legacy linear sessions and an empty side', () => {
    const linear: Session = {
      id: 's',
      title: 'Linear',
      createdAt: 1,
      updatedAt: 2,
      messages: [user('u1', 1), reply('a1', 2)],
    }
    const empty: Session = {
      id: 's',
      title: '',
      createdAt: 5,
      updatedAt: 5,
      messages: [],
      rootMessageId: null,
    }
    const merged = mergeSessions(empty, linear, { localModifiedAt: 20, remoteModifiedAt: 10 })
    expect(visible(merged)).toEqual(['u1', 'a1'])
    expect(merged.createdAt).toBe(1)
  })
})
