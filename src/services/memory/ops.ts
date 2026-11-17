import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryChange,
  type MemoryItem,
  type MemorySource,
} from '../chat/types.js'
import type { MemoryLogEntry } from '../chat/db.js'
import { ALL_PROMPTS } from './prompts.js'

/**
 * 模型输出的记忆操作：解析与校验，都是纯函数。
 * 模型只提出改动，是否落库由这里按规则决定：用户确认过的条目不让后台整理改动，
 * 疑似凭证直接丢弃，敏感内容先问再记，数量有上限。
 */

/** 记忆条目总数上限：到上限后不再自动新增，并触发一次整理 */
export const ITEM_LIMIT = 80
/** 单条记忆的长度上限 */
export const ITEM_TEXT_LIMIT = 120
/** 用户删除、撤销或拒绝过的记忆保留的条数 */
export const FORGOTTEN_LIMIT = 50
/** 回答后提取一次最多改动的条数 */
const EXTRACT_CAPS = { add: 5, update: 3, delete: 3 }
/**
 * 后台整理一次删光全部自动条目，或条目较多时删掉超过这个比例，整批作废，疑似输出异常。
 * 旧版档案里常有大量一次性的琐事，第一次整理删掉其中多数是正常的，所以条目少时不按比例拦。
 */
const CONSOLIDATE_MAX_REMOVE_RATIO = 0.6
const CONSOLIDATE_RATIO_FROM = 10

export type ParsedOp =
  | { type: 'add' | 'ask'; category: MemoryCategory; text: string }
  | { type: 'update'; ref: number; category: MemoryCategory | null; text: string }
  | { type: 'delete'; refs: number[] }
  | { type: 'merge'; refs: number[]; category: MemoryCategory | null; text: string }

export type ParsedOutput = {
  /** 备忘原文；没有备忘时为 null */
  note: string | null
  ops: ParsedOp[]
  /** 是否以 END 结束。没有结束标记说明输出被截断或格式不对，操作一律不用 */
  complete: boolean
}

const normalizeKey = (text: string) => text.toLowerCase().replace(/[\s_\-·・]/g, '')

const CATEGORY_ALIASES = new Map<string, MemoryCategory>()
for (const prompts of ALL_PROMPTS) {
  for (const category of MEMORY_CATEGORIES) {
    CATEGORY_ALIASES.set(normalizeKey(prompts.categories[category]), category)
  }
}
for (const category of MEMORY_CATEGORIES) {
  CATEGORY_ALIASES.set(category, category)
}

const CATEGORY_KEYWORDS: [RegExp, MemoryCategory][] = [
  [/偏好|习惯|喜好|prefer|habit|like/i, 'preferences'],
  [/进行|计划|项目|progress|ongoing|plan|project|current/i, 'ongoing'],
  [/人|事件|关系|people|person|event|relationship|family/i, 'people'],
  [/基本|身份|背景|basic|about|identity|background/i, 'basics'],
]

/** 分类名可能是任一语言、带空格或用了近义词；认不出的归入「其他」 */
export const parseCategory = (raw: string): MemoryCategory => {
  const key = normalizeKey(raw)
  const exact = CATEGORY_ALIASES.get(key)
  if (exact) {
    return exact
  }
  return CATEGORY_KEYWORDS.find(([pattern]) => pattern.test(raw))?.[1] ?? 'other'
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** 记忆条目的规范文本：单行、去掉包裹的引号和编号、限长；不合格时为空字符串 */
export const cleanItemText = (raw: string): string => {
  let text = oneLine(raw)
    .replace(/^(?:\[?m\d+\]?|\[?k\d+\]?)\s*[:：]?\s*/i, '')
    // 模型偶尔在末尾加括号说明来源，例如「（用户明确要求记住）」，不属于这件事本身
    .replace(
      /\s*[（(][^（）()]*(?:用户|要求|记住|确认|remember|user|asked)[^（）()]*[）)]\s*$/i,
      ''
    )
    .replace(/[。.；;，,]+$/, '')
    .replace(/^[「“"'‘『]+|[」”"'’』]+$/g, '')
    .replace(/[。.；;，,]+$/, '')
    .trim()
  if (text.length > ITEM_TEXT_LIMIT) {
    text = `${text.slice(0, ITEM_TEXT_LIMIT - 1).trimEnd()}…`
  }
  return text
}

const comparable = (text: string) =>
  normalizeKey(text).replace(/[。.；;，,！!？?「」“”"'（）()【】[\]]/g, '')

/** 比较两条记忆是否说的是同一句话 */
export const sameText = (a: string, b: string) => comparable(a) === comparable(b)

/**
 * 两条记忆是否说的是同一件事：同一句话，或一句完整包含另一句（较短的一句至少 4 个字）。
 * 用于去重和拦截删除过的内容，避免换个说法、加个括号就又记回来。
 */
export const similarText = (a: string, b: string) => {
  const [x, y] = [comparable(a), comparable(b)]
  if (x === y) {
    return true
  }
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x]
  return shorter.length >= 4 && longer.includes(shorter)
}

const OP_LINE = /^(NOTE|ADD|ASK|UPDATE|DELETE|MERGE|END)\b\s*[:：]?\s*(.*)$/i
const CATEGORY_PREFIX = /^[[【［(（]\s*([^\]】］)）]{1,24}?)\s*[\]】］)）]\s*(.*)$/
const REF_PREFIX = /^[[【［]?\s*k\s*0*(\d{1,3})\s*[\]】］]?\s*(?:[:：=]|->|→)?\s*(.*)$/i
const REF_TOKEN = /\bk\s*0*(\d{1,3})\b/gi

const splitCategory = (rest: string): { category: MemoryCategory | null; text: string } => {
  const match = rest.match(CATEGORY_PREFIX)
  return match
    ? { category: parseCategory(match[1]), text: match[2] }
    : { category: null, text: rest }
}

/** 去掉模型偶尔加的列表符号、加粗和引用符号 */
const stripDecoration = (line: string) =>
  line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*•·]|\d{1,2}[.)、])\s+/, '')
    .replace(/^\*\*(.+?)\*\*/, '$1')
    .trim()

const stripFence = (output: string) => {
  const fenced = output.trim().match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/)
  return fenced ? fenced[1] : output
}

/**
 * 解析提取或整理的输出。格式：一行 NOTE、若干行操作、最后一行 END。
 * - 备忘是 NOTE 那一行加上它之后、第一条操作之前的非操作行；没有 NOTE 前缀时取第一条操作之前的内容；
 * - 第一条操作之后的非操作行一律丢弃，不会混进备忘；
 * - 完全没有操作、NOTE 和 END 时，整段当作备忘（与只写备忘的旧格式一致）。
 */
export const parseModelOutput = (output: string): ParsedOutput => {
  const lines = stripFence(output).split('\n')
  const noteLines: string[] = []
  const ops: ParsedOp[] = []
  let sawStructure = false
  let sawOp = false
  let complete = false
  for (const raw of lines) {
    const line = stripDecoration(raw)
    if (!line) {
      continue
    }
    const match = line.match(OP_LINE)
    if (!match) {
      if (!sawOp) {
        noteLines.push(line)
      }
      continue
    }
    const keyword = match[1].toUpperCase()
    const rest = match[2].trim()
    sawStructure = true
    if (keyword === 'END') {
      complete = true
      break
    }
    if (keyword === 'NOTE') {
      if (!sawOp) {
        noteLines.length = 0
        if (rest) {
          noteLines.push(rest)
        }
      }
      continue
    }
    sawOp = true
    if (keyword === 'ADD' || keyword === 'ASK') {
      const { category, text } = splitCategory(rest)
      ops.push({ type: keyword === 'ADD' ? 'add' : 'ask', category: category ?? 'other', text })
    } else if (keyword === 'UPDATE') {
      const ref = rest.match(REF_PREFIX)
      if (ref) {
        const { category, text } = splitCategory(ref[2])
        ops.push({ type: 'update', ref: Number(ref[1]), category, text })
      }
    } else if (keyword === 'DELETE') {
      const refs = [...rest.matchAll(REF_TOKEN)].map((item) => Number(item[1]))
      if (refs.length) {
        ops.push({ type: 'delete', refs })
      }
    } else if (keyword === 'MERGE') {
      // 开头连续的编号是要合并的条目，之后是合并后的内容
      const head = rest.match(/^((?:[[【［]?\s*k\s*\d{1,3}\s*[\]】］]?\s*[,，、+和&]?\s*)+)(.*)$/i)
      if (head) {
        const refs = [...head[1].matchAll(REF_TOKEN)].map((item) => Number(item[1]))
        const { category, text } = splitCategory(head[2].replace(/^[:：=→]|^->/, '').trim())
        if (refs.length >= 2) {
          ops.push({ type: 'merge', refs, category, text })
        }
      }
    }
  }
  if (!sawStructure) {
    return { note: output.trim() || null, ops: [], complete: false }
  }
  return { note: noteLines.length ? noteLines.join(' ') : null, ops, complete }
}

/** 疑似凭证：长数字串（卡号、证件号）、常见密钥前缀、长随机串 */
const CREDENTIAL =
  /(?:\d[\s-]?){12,}|\b(?:sk|pk|rk|ak|ghp|xox[abp])[-_][A-Za-z0-9_-]{10,}|\b[A-Za-z0-9+/_-]{32,}\b|密码\s*[:：是为]\s*\S|password\s*[:=]\s*\S/i

/** 敏感内容：命中时即使模型用了 ADD 也先问用户（用户明确要求记住的除外） */
const SENSITIVE =
  /病|癌|抑郁|焦虑症|躁郁|糖尿病|高血压|艾滋|怀孕|流产|服药|处方|诊断|心理咨询|心理治疗|残疾|负债|欠款|欠债|贷款|月薪|年薪|工资|存款|破产|同性恋|双性恋|性取向|跨性别|出柜|宗教|信仰|基督|佛教|伊斯兰|穆斯林|党员|政治立场|diagnos|disease|cancer|depress|anxiety disorder|bipolar|diabet|hiv|pregnan|miscarriage|medication|prescription|therapy|therapist|disabilit|debt|salary|income|loan|bankrupt|\bgay\b|lesbian|bisexual|transgender|sexual orientation|religio|christian|muslim|buddhis|political (?:view|party)/i

export const isCredentialLike = (text: string) => CREDENTIAL.test(text)
export const isSensitive = (text: string) => SENSITIVE.test(text)

/** 用户明确要求记住 */
export const REMEMBER_REQUEST =
  /记住|帮我记|别忘了|不要忘了|remember|don't forget|do not forget|keep in mind/i
/** 用户明确要求忘掉；和上面一起用于决定回答后是否立即整理 */
export const FORGET_REQUEST =
  /忘掉|忘了吧|别记|不要记|删掉.{0,8}记忆|forget|don't remember|stop remembering/i

const mutedMatch = (text: string, muted: string[]) =>
  muted.some((item) => {
    const a = normalizeKey(text)
    const b = normalizeKey(item)
    return Boolean(b) && (a === b || a.includes(b) || b.includes(a))
  })

export type OpContext = {
  mode: 'extract' | 'consolidate'
  /** 事务里读到的全部条目（含待确认） */
  items: MemoryItem[]
  /** 发给模型时的编号：refs[n - 1] 是 kn 对应的条目，以及当时的 updatedAt */
  refs: { id: string; updatedAt: number }[]
  forgotten: string[]
  muted: string[]
  /** 用户这次明确要求记住 */
  explicit: boolean
  /** 提取时这次对话的出处 */
  source: MemorySource | null
  now: number
  createId: () => string
}

export type OpResult = {
  put: MemoryItem[]
  remove: string[]
  /** 给对话内提示用（只有提取会用到） */
  changes: MemoryChange[]
  /** 给活动记录用 */
  log: NonNullable<MemoryLogEntry['changes']>
  /** 因用户请求被删除的条目文本：要记入 forgotten，并清理相关摘要 */
  forgotten: MemoryItem[]
  /** 整理删除过多，疑似输出异常，整批不用 */
  unsafe: boolean
}

const addSource = (sources: MemorySource[], source: MemorySource | null) =>
  source && !sources.some((item) => item.sessionId === source.sessionId)
    ? [...sources, source]
    : sources

/**
 * 按规则把模型提出的操作落到条目上。只接受编号对得上、且在调用期间没有被改过的条目；
 * 后台整理不能改动用户确认过的条目，也不能新增敏感内容。
 */
export const applyOps = (ops: ParsedOp[], context: OpContext): OpResult => {
  const { mode, now, source } = context
  const byId = new Map(context.items.map((item) => [item.id, item]))
  const result: OpResult = {
    put: [],
    remove: [],
    changes: [],
    log: [],
    forgotten: [],
    unsafe: false,
  }
  const touched = new Set<string>()
  const counts = { add: 0, update: 0, delete: 0 }
  const live = () => [...byId.values()]
  /** kn → 条目：编号要存在，条目还在、调用期间没被改过、这次还没被改过 */
  const resolve = (ref: number) => {
    const entry = context.refs[ref - 1]
    const item = entry && byId.get(entry.id)
    if (!item || item.updatedAt !== entry.updatedAt || touched.has(item.id)) {
      return null
    }
    return item
  }
  const editable = (item: MemoryItem) =>
    item.status === 'saved' && (mode === 'extract' || item.origin === 'auto')
  const put = (item: MemoryItem) => {
    byId.set(item.id, item)
    touched.add(item.id)
    result.put = [...result.put.filter((other) => other.id !== item.id), item]
  }
  const remove = (item: MemoryItem) => {
    byId.delete(item.id)
    touched.add(item.id)
    result.put = result.put.filter((other) => other.id !== item.id)
    result.remove.push(item.id)
  }
  let fullReported = false

  for (const op of ops) {
    if (op.type === 'add' || op.type === 'ask') {
      if (mode === 'consolidate' && op.type === 'ask') {
        continue
      }
      const text = cleanItemText(op.text)
      if (!text || isCredentialLike(text) || mutedMatch(text, context.muted)) {
        continue
      }
      if (live().some((item) => similarText(item.text, text))) {
        continue
      }
      const sensitive = op.type === 'ask' || isSensitive(text)
      if (mode === 'consolidate' && sensitive) {
        continue
      }
      const remembered = context.explicit && op.type === 'add'
      if (!remembered && context.forgotten.some((item) => similarText(item, text))) {
        continue
      }
      if (mode === 'extract' && counts.add >= EXTRACT_CAPS.add) {
        continue
      }
      if (live().length >= ITEM_LIMIT) {
        if (mode === 'extract' && !fullReported) {
          result.changes.push({ kind: 'full', text, at: now })
          fullReported = true
        }
        continue
      }
      counts.add += 1
      const pending = mode === 'extract' && !remembered && sensitive
      const item: MemoryItem = {
        id: context.createId(),
        text,
        category: op.category,
        origin: remembered ? 'user' : 'auto',
        status: pending ? 'pending' : 'saved',
        sources: addSource([], source),
        createdAt: now,
        updatedAt: now,
      }
      put(item)
      result.changes.push({ kind: pending ? 'asked' : 'added', itemId: item.id, text, at: now })
      result.log.push({ kind: pending ? 'asked' : 'added', text })
    } else if (op.type === 'update') {
      const item = resolve(op.ref)
      const text = cleanItemText(op.text)
      if (
        !item ||
        !editable(item) ||
        !text ||
        isCredentialLike(text) ||
        mutedMatch(text, context.muted) ||
        (!context.explicit && context.forgotten.some((entry) => similarText(entry, text))) ||
        sameText(item.text, text)
      ) {
        continue
      }
      if (
        isSensitive(text) &&
        !isSensitive(item.text) &&
        (mode === 'consolidate' || !context.explicit)
      ) {
        continue
      }
      if (mode === 'extract' && counts.update++ >= EXTRACT_CAPS.update) {
        continue
      }
      const next: MemoryItem = {
        ...item,
        text,
        category: op.category ?? item.category,
        sources: addSource(item.sources, source),
        updatedAt: now,
      }
      put(next)
      result.changes.push({
        kind: 'updated',
        itemId: item.id,
        text,
        previous: item.text,
        at: now,
      })
      result.log.push({ kind: 'updated', text })
    } else if (op.type === 'delete') {
      for (const ref of op.refs) {
        const item = resolve(ref)
        if (!item || !editable(item)) {
          continue
        }
        if (mode === 'extract' && counts.delete++ >= EXTRACT_CAPS.delete) {
          continue
        }
        remove(item)
        result.changes.push({ kind: 'removed', itemId: item.id, text: item.text, item, at: now })
        result.log.push({ kind: 'removed', text: item.text })
        if (mode === 'extract') {
          result.forgotten.push(item)
        }
      }
    } else if (op.type === 'merge' && mode === 'consolidate') {
      const items = op.refs.map(resolve)
      const text = cleanItemText(op.text)
      // 合并要么整条成立，要么整条不做：只做一半会丢内容
      if (
        !text ||
        items.some((item) => !item || !editable(item)) ||
        new Set(op.refs).size !== op.refs.length ||
        isCredentialLike(text) ||
        mutedMatch(text, context.muted) ||
        context.forgotten.some((entry) => similarText(entry, text)) ||
        (isSensitive(text) && !items.some((item) => item && isSensitive(item.text)))
      ) {
        continue
      }
      const [survivor, ...merged] = items as MemoryItem[]
      put({
        ...survivor,
        text,
        category: op.category ?? survivor.category,
        sources: merged.reduce(
          (sources, item) => item.sources.reduce(addSource, sources),
          survivor.sources
        ),
        aliases: [
          ...new Set([
            ...(survivor.aliases ?? []),
            ...merged.flatMap((item) => [item.id, ...(item.aliases ?? [])]),
          ]),
        ],
        updatedAt: now,
      })
      for (const item of merged) {
        remove(item)
      }
      result.log.push({ kind: 'merged', text })
    }
  }

  if (mode === 'consolidate') {
    const auto = context.items.filter((item) => item.status === 'saved' && item.origin === 'auto')
    const removed = result.remove.length
    const wiped = auto.length >= 3 && removed >= auto.length
    const tooMany =
      auto.length >= CONSOLIDATE_RATIO_FROM && removed > auto.length * CONSOLIDATE_MAX_REMOVE_RATIO
    result.unsafe = wiped || tooMany
  }
  return result
}

/** 把文本加入 forgotten（去重、只留最近若干条） */
export const rememberForgotten = (
  forgotten: { text: string; at: number }[] | undefined,
  texts: string[],
  now: number
): { text: string; at: number }[] => {
  const kept = (forgotten ?? []).filter((item) => !texts.some((text) => sameText(text, item.text)))
  return [...kept, ...texts.map((text) => ({ text, at: now }))].slice(-FORGOTTEN_LIMIT)
}
