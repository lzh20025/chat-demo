import type { MemoryPlan, MemoryProfile } from '../chat/db.js'
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryChange,
  type MemoryItem,
} from '../chat/types.js'
import { createId } from '../../utils/id.js'
import { cleanItemText, isCredentialLike, ITEM_LIMIT, rememberForgotten, sameText } from './ops.js'
import { commit, emptyProfile, getMemory, readClearedAt } from './state.js'
import { scheduleScrub } from './store.js'

/**
 * 用户对记忆的操作：添加、编辑、删除、别再提、确认、撤销、导入导出。
 * 每个操作都在一个事务里基于最新数据完成，并记下用户改动的时间：
 * 后台整理期间用户动过记忆，那次整理作废；用户添加、编辑、确认的条目之后不会被后台整理改动。
 */

type Current = { items: MemoryItem[]; profile: MemoryProfile; now: number }

const userCommit = (plan: (current: Current) => MemoryPlan | null) =>
  commit({
    invalidate: true,
    plan: ({ items, profile }) => {
      const now = Date.now()
      const result = plan({ items, profile: profile ?? emptyProfile(), now })
      return (
        result && {
          ...result,
          profile: { ...(result.profile ?? profile ?? emptyProfile()), updatedAt: now },
        }
      )
    },
  })

/** 按 id 找条目；条目被合并进别的条目时，用它的 id 也能找到合并后的那条 */
export const findItem = (items: MemoryItem[], id: string): MemoryItem | undefined =>
  items.find((item) => item.id === id) ?? items.find((item) => item.aliases?.includes(id))

/** 按原文找条目：较早的回答没有保存条目 id，只能这样对应 */
export const findItemByText = (items: MemoryItem[], text: string): MemoryItem | undefined =>
  items.find((item) => sameText(item.text, text))

/** 删除时要清理的摘要：条目出现过的对话；没有出处的涉及所有对话 */
const unscrubEntry = (text: string, at: number, sessionIds: string[]) => ({
  text,
  at,
  ...(sessionIds.length ? { sessionIds: [...new Set(sessionIds)] } : {}),
})

const sourceIds = (item: MemoryItem) => item.sources.map((source) => source.sessionId)

/** 手动添加一条；内容为空、重复或疑似凭证时返回 false */
export const addItem = async (raw: string, category: MemoryCategory): Promise<boolean> => {
  const text = cleanItemText(raw)
  if (!text || isCredentialLike(text)) {
    return false
  }
  const result = await userCommit(({ items, profile, now }) => {
    const existing = findItemByText(items, text)
    if (existing) {
      return existing.status === 'pending'
        ? { putItems: [{ ...existing, status: 'saved', origin: 'user', updatedAt: now }] }
        : null
    }
    if (items.length >= ITEM_LIMIT) {
      return null
    }
    return {
      putItems: [
        {
          id: createId(),
          text,
          category,
          origin: 'user',
          status: 'saved',
          sources: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      profile: {
        ...profile,
        forgotten: (profile.forgotten ?? []).filter((item) => !sameText(item.text, text)),
      },
    }
  })
  return Boolean(result)
}

/** 编辑一条：之后视为用户确认过的内容。条目已不存在时返回 false */
export const editItem = async (
  id: string,
  raw: string,
  category?: MemoryCategory
): Promise<boolean> => {
  const text = cleanItemText(raw)
  if (!text || isCredentialLike(text)) {
    return false
  }
  const result = await userCommit(({ items, now }) => {
    const item = findItem(items, id)
    return item
      ? {
          putItems: [
            {
              ...item,
              text,
              category: category ?? item.category,
              origin: 'user',
              status: 'saved',
              updatedAt: now,
            },
          ],
        }
      : null
  })
  return Boolean(result)
}

/**
 * 删除一条：记入删除过的内容（后台整理不再原样记回来），并清理它出现过的对话摘要。
 * 之后用户在对话里明确再说一次，仍然可以记住。
 */
export const forgetItem = async (id: string): Promise<boolean> => {
  const result = await userCommit(({ items, profile, now }) => {
    const item = findItem(items, id)
    if (!item) {
      return null
    }
    return {
      deleteItems: [item.id],
      profile: {
        ...profile,
        forgotten: rememberForgotten(profile.forgotten, [item.text], now),
        unscrubbed: [...(profile.unscrubbed ?? []), unscrubEntry(item.text, now, sourceIds(item))],
      },
    }
  })
  if (result) {
    scheduleScrub()
  }
  return Boolean(result)
}

/**
 * 「别再提这件事」：删掉这一条（找得到的话），并记入不再提及的清单。
 * 清单会交给之后的整理和回答；所有对话摘要里的相关内容用一次模型调用删掉，
 * 清理完成之前（包括记忆关闭、没有 API Key、请求失败），旧摘要不注入，之后启动或重新开启时重试。
 */
export const muteItem = async ({ id, text }: { id?: string; text: string }): Promise<void> => {
  const result = await userCommit(({ items, profile, now }) => {
    const item = (id ? findItem(items, id) : undefined) ?? findItemByText(items, text)
    const target = item?.text ?? text
    const muted = profile.muted ?? []
    return {
      deleteItems: item ? [item.id] : [],
      profile: {
        ...profile,
        muted: muted.some((entry) => sameText(entry, target)) ? muted : [...muted, target],
        unscrubbed: [
          ...(profile.unscrubbed ?? []).filter((entry) => entry.text !== target),
          { text: target, at: now },
        ],
      },
    }
  })
  if (result) {
    scheduleScrub()
  }
}

/** 从不再提及的清单里移除一条；不会自动写回记忆，之后的整理可以重新记录 */
export const unmuteItem = async (text: string): Promise<void> => {
  await userCommit(({ profile }) => {
    const muted = (profile.muted ?? []).filter((item) => item !== text)
    const unscrubbed = (profile.unscrubbed ?? []).filter((item) => item.text !== text)
    return {
      profile: {
        ...profile,
        muted: muted.length ? muted : undefined,
        unscrubbed: unscrubbed.length ? unscrubbed : undefined,
      },
    }
  })
}

/** 确认一条待确认的敏感内容：生效并视为用户确认过 */
export const confirmItem = async (id: string): Promise<boolean> => {
  const result = await userCommit(({ items, now }) => {
    const item = findItem(items, id)
    return item?.status === 'pending'
      ? { putItems: [{ ...item, status: 'saved', origin: 'user', updatedAt: now }] }
      : null
  })
  return Boolean(result)
}

/** 不记这条待确认的内容：删除，之后不再询问，并清理那次对话的摘要 */
export const dismissItem = async (id: string): Promise<boolean> => {
  const result = await userCommit(({ items, profile, now }) => {
    const item = findItem(items, id)
    if (item?.status !== 'pending') {
      return null
    }
    return {
      deleteItems: [item.id],
      profile: {
        ...profile,
        forgotten: rememberForgotten(profile.forgotten, [item.text], now),
        unscrubbed: [...(profile.unscrubbed ?? []), unscrubEntry(item.text, now, sourceIds(item))],
      },
    }
  })
  if (result) {
    scheduleScrub()
  }
  return Boolean(result)
}

/** 对话内一条改动当前的状态，供提示决定显示什么 */
export type ChangeState =
  /** 条目自那次改动后没再变过，可以撤销 */
  | 'undoable'
  /** 已撤销、已删除，或待确认的内容被拒绝 */
  | 'gone'
  /** 之后被编辑、整理或合并过，不能直接撤销 */
  | 'changed'
  /** 待确认 */
  | 'pending'
  /** 待确认的内容已被确认 */
  | 'confirmed'
  /** 记忆已满，没能记下 */
  | 'full'

export const getChangeState = (change: MemoryChange, items: MemoryItem[]): ChangeState => {
  if (change.kind === 'full') {
    return 'full'
  }
  if (change.kind === 'removed') {
    // 放回来了（撤销时已有同样内容的条目则不重复放）
    return items.some((item) => item.id === change.itemId) ||
      findItemByText(items, change.item.text)
      ? 'gone'
      : 'undoable'
  }
  const item = findItem(items, change.itemId)
  if (!item) {
    return 'gone'
  }
  if (change.kind === 'asked') {
    return item.status === 'pending' ? 'pending' : 'confirmed'
  }
  if (item.id === change.itemId && item.updatedAt === change.at) {
    return 'undoable'
  }
  // 撤销修改会把条目改回原来的内容
  return change.kind === 'updated' &&
    item.id === change.itemId &&
    sameText(item.text, change.previous)
    ? 'gone'
    : 'changed'
}

/** 改动是否早于上次清空记忆：清空后旧对话里的提示不再显示 */
export const isChangeCleared = (change: MemoryChange) => change.at <= readClearedAt()

/**
 * 撤销对话里的一次改动。sessionId 是改动发生的对话：撤销新增或修改时，那次对话的摘要里还带着这件事，一并清理。
 * 条目之后又被改过时不撤销，返回 false。
 */
export const undoChange = async (change: MemoryChange, sessionId: string): Promise<boolean> => {
  if (change.kind === 'full' || change.kind === 'asked') {
    return false
  }
  const result = await userCommit(({ items, profile, now }) => {
    if (change.kind === 'removed') {
      if (items.some((item) => item.id === change.itemId)) {
        return null
      }
      const duplicate = findItemByText(items, change.item.text)
      return {
        putItems: duplicate ? [] : [{ ...change.item, updatedAt: now }],
        profile: {
          ...profile,
          forgotten: (profile.forgotten ?? []).filter(
            (item) => !sameText(item.text, change.item.text)
          ),
          unscrubbed: (profile.unscrubbed ?? []).filter((item) => item.text !== change.item.text),
        },
      }
    }
    const item = items.find((entry) => entry.id === change.itemId)
    if (!item || item.updatedAt !== change.at) {
      return null
    }
    const scrub = {
      forgotten: rememberForgotten(profile.forgotten, [change.text], now),
      unscrubbed: [
        ...(profile.unscrubbed ?? []),
        unscrubEntry(change.text, now, [...sourceIds(item), sessionId]),
      ],
    }
    return change.kind === 'updated'
      ? {
          putItems: [{ ...item, text: change.previous, updatedAt: now }],
          profile: { ...profile, ...scrub },
        }
      : { deleteItems: [item.id], profile: { ...profile, ...scrub } }
  })
  if (result && change.kind !== 'removed') {
    scheduleScrub()
  }
  return Boolean(result)
}

/** 随历史导出的记忆：只含已生效的条目和不再提及的清单 */
export type MemoryExport = {
  version: 1
  items: { text: string; category: MemoryCategory; origin: 'auto' | 'user'; createdAt: number }[]
  muted: string[]
}

export const exportMemory = (): MemoryExport | null => {
  const { items, profile } = getMemory()
  const saved = items.filter((item) => item.status === 'saved')
  const muted = profile?.muted ?? []
  if (!saved.length && !muted.length) {
    return null
  }
  return {
    version: 1,
    items: saved.map(({ text, category, origin, createdAt }) => ({
      text,
      category,
      origin,
      createdAt,
    })),
    muted,
  }
}

/**
 * 导入记忆：与本地合并。条目文本当作不可信输入重新清洗，重复的、命中不再提及的、超过条数上限的跳过；
 * 导入的不再提及按正常流程加入并清理摘要。返回新增的条目数。
 */
export const importMemory = async (data: MemoryExport): Promise<number> => {
  const outcome = { added: 0, muted: false }
  await userCommit(({ items, profile, now }) => {
    const localMuted = profile.muted ?? []
    const muted = [...localMuted]
    const unscrubbed = [...(profile.unscrubbed ?? [])]
    for (const raw of data.muted) {
      const text = cleanItemText(raw)
      if (text && !muted.some((item) => sameText(item, text))) {
        muted.push(text)
        unscrubbed.push({ text, at: now })
      }
    }
    const added: MemoryItem[] = []
    for (const entry of data.items) {
      const text = cleanItemText(entry.text)
      if (
        !text ||
        isCredentialLike(text) ||
        items.length + added.length >= ITEM_LIMIT ||
        [...items, ...added].some((item) => sameText(item.text, text)) ||
        muted.some((item) => sameText(item, text))
      ) {
        continue
      }
      added.push({
        id: createId(),
        text,
        category: MEMORY_CATEGORIES.includes(entry.category) ? entry.category : 'other',
        origin: entry.origin === 'user' ? 'user' : 'auto',
        status: 'saved',
        sources: [],
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
        updatedAt: now,
      })
    }
    outcome.added = added.length
    outcome.muted = muted.length > localMuted.length
    if (!added.length && !outcome.muted) {
      return null
    }
    // 与别再提一样：本地已有、但导入时要求不再提及的条目一并删除
    const newlyMuted = muted.slice(localMuted.length)
    return {
      putItems: added,
      deleteItems: items
        .filter((item) => newlyMuted.some((text) => sameText(text, item.text)))
        .map((item) => item.id),
      profile: {
        ...profile,
        muted: muted.length ? muted : undefined,
        unscrubbed: unscrubbed.length ? unscrubbed : undefined,
      },
    }
  })
  if (outcome.muted) {
    scheduleScrub()
  }
  return outcome.added
}
