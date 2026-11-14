import type { Locale } from '../settings.js'

/**
 * 记忆相关的提示词。只依赖「system + 一条 user 消息 → 文本」这一最小能力，
 * 不使用任何服务端扩展，换用其他模型服务时无需改动。
 */
type Prompts = {
  /** 注入 system 的记忆块开头，说明这份记忆的来源与用法 */
  injectHeader: string
  profileHeading: string
  recentHeading: string
  /** 尚未生成摘要的会话，直接给出用户原话节选 */
  rawLabel: string
  untitled: string
  digestSystem: string
  dreamSystem: string
  dreamToday: string
  dreamCurrentProfile: string
  dreamEmptyProfile: string
  dreamUserEdited: string
  dreamNewDigests: string
  userLabel: string
  assistantLabel: string
}

/** 摘要判断对话没有值得记的内容时输出的标记 */
export const SKIP_MARK = 'SKIP'

const zh: Prompts = {
  injectHeader:
    '以下是系统根据过往对话自动整理的用户记忆，可能不完整或已过时。请自然地利用它来理解用户，不要逐条复述，也不要主动提起自己有这份记忆；与用户当前所说冲突时，以当前所说为准。用户问起你记得什么时如实回答。',
  profileHeading: '# 用户档案',
  recentHeading: '# 近期对话（由新到旧）',
  rawLabel: '用户原话节选',
  untitled: '未命名对话',
  digestSystem: [
    '你负责为一段对话写备忘，供同一位用户之后开启新对话时参考。',
    '要求：',
    '- 用 1-3 句话写清：用户想做什么、透露了哪些关于自己的信息或偏好、得出了什么结论或决定、还有什么没做完。',
    '- 以用户说的内容为主，助手的回答只保留结论。',
    '- 要具体：保留名称、数字、日期等关键细节，不写「用户问了一个问题」这类空话。',
    '- 不记录密码、密钥、证件号、银行卡号等凭证信息。',
    '- 使用对话所用的语言，不超过 150 字，只输出备忘正文，不加标题或前缀。',
    `- 对话只有寒暄、没有任何实质内容时，只输出 ${SKIP_MARK}。`,
  ].join('\n'),
  dreamSystem: [
    '你负责维护一份关于用户的长期档案。助手会在之后每次对话开始时阅读它，以便像一直认识这位用户一样提供帮助。',
    '你会收到：当前日期、现有档案（可能为空）、自上次整理以来新增的对话备忘。请输出更新后的完整档案。',
    '要求：',
    '- 重写而不是追加：合并重复内容，删除已被新信息推翻的内容，把已经过去的计划改写为已发生的事（对照当前日期）。',
    '- 可以根据多次对话归纳用户的兴趣、习惯和偏好的沟通方式，但归纳必须有依据；只出现过一次的琐事不必写入。',
    '- 现有档案里的内容默认保留，除非新备忘中用户自己推翻了它。',
    '- 健康、财务、性取向、宗教、政治立场等敏感信息，只有用户明确说过才可记录，不得推测。',
    '- 不记录密码、密钥、证件号、银行卡号等凭证信息。',
    '- 新备忘里没有值得长期记住的内容时，原样输出现有档案。',
    '- 使用 Markdown，按需使用这些小节（没有内容的省略）：## 基本情况、## 正在进行的事、## 偏好与习惯、## 重要的人和事、## 其他。每条一行，以「- 」开头。',
    '- 使用用户常用的语言，总长度不超过 1200 字。只输出档案正文。',
  ].join('\n'),
  dreamToday: '当前日期',
  dreamCurrentProfile: '现有档案',
  dreamEmptyProfile: '（空）',
  dreamUserEdited: '注意：用户在上次整理之后亲自修改过这份档案，其中的内容视为用户确认过的事实。',
  dreamNewDigests: '新增的对话备忘（由旧到新）',
  userLabel: '用户',
  assistantLabel: '助手',
}

const en: Prompts = {
  injectHeader:
    'Below is memory about the user that the system compiled automatically from earlier conversations. It may be incomplete or out of date. Use it naturally to understand the user; do not recite it or volunteer that you have it. If it conflicts with what the user says now, trust what they say now. If the user asks what you remember, answer truthfully.',
  profileHeading: '# User profile',
  recentHeading: '# Recent conversations (newest first)',
  rawLabel: 'excerpt of what the user said',
  untitled: 'Untitled chat',
  digestSystem: [
    'You write a short note about a conversation, for reference when the same user starts a new conversation later.',
    'Rules:',
    '- In 1-3 sentences, state what the user wanted, what they revealed about themselves or their preferences, what was concluded or decided, and what is still unfinished.',
    "- Focus on what the user said; keep only the conclusions of the assistant's answers.",
    '- Be specific: keep names, numbers and dates. Avoid empty phrases such as "the user asked a question".',
    '- Never record passwords, keys, ID numbers, card numbers or other credentials.',
    '- Write in the language of the conversation, at most 80 words, and output only the note with no heading or prefix.',
    `- If the conversation is only small talk with nothing of substance, output only ${SKIP_MARK}.`,
  ].join('\n'),
  dreamSystem: [
    'You maintain a long-term profile of the user. The assistant reads it at the start of every later conversation so it can help as if it had known the user all along.',
    "You receive today's date, the current profile (possibly empty), and conversation notes added since the last update. Output the complete updated profile.",
    'Rules:',
    "- Rewrite, do not append: merge duplicates, remove what newer information contradicts, and turn plans that are now in the past into things that happened (compare with today's date).",
    "- You may generalise the user's interests, habits and preferred communication style across conversations, but only with evidence; skip trivia that appeared once.",
    '- Keep what the current profile says unless the user contradicted it in the new notes.',
    '- Record sensitive information (health, finances, sexual orientation, religion, political views) only when the user stated it explicitly; never infer it.',
    '- Never record passwords, keys, ID numbers, card numbers or other credentials.',
    '- If the new notes contain nothing worth remembering long term, output the current profile unchanged.',
    '- Use Markdown with these sections as needed (omit empty ones): ## Basics, ## In progress, ## Preferences and habits, ## Important people and events, ## Other. One item per line, starting with "- ".',
    '- Write in the language the user normally uses, at most 600 words. Output only the profile.',
  ].join('\n'),
  dreamToday: "Today's date",
  dreamCurrentProfile: 'Current profile',
  dreamEmptyProfile: '(empty)',
  dreamUserEdited:
    'Note: the user edited this profile by hand after the last update. Treat its contents as facts the user confirmed.',
  dreamNewDigests: 'New conversation notes (oldest first)',
  userLabel: 'User',
  assistantLabel: 'Assistant',
}

export const getPrompts = (locale: Locale): Prompts => (locale === 'zh-CN' ? zh : en)
