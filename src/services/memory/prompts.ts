import type { MemoryCategory } from '../chat/types.js'
import type { Locale } from '../settings.js'
import { MEMORY_USED_TAG } from './marker.js'

/**
 * 记忆相关的提示词。只依赖「system + 一条 user 消息 → 文本」这一最小能力，
 * 不使用任何服务端扩展，换用其他模型服务时无需改动。
 *
 * 注意：profileHeading、recentHeading、mutedHeading 和 injectAttribution 的第一行会被
 * parseMemoryBlock 按原文匹配，用来解析回答上保存的旧记忆块，不要改动。
 */
type Prompts = {
  /** 注入 system 的记忆块开头，说明这份记忆的来源与用法 */
  injectHeader: string
  /** 记忆块末尾：要求模型在回答末尾报出实际用到的记忆编号 */
  injectAttribution: string
  profileHeading: string
  /** 记忆块里各分类的小节标题，也是提取与整理时让模型使用的分类名 */
  categories: Record<MemoryCategory, string>
  /** 用户要求不再提及的事 */
  mutedHeading: string
  mutedIntro: string
  /** 生成摘要时附在 system 之后：这些事不要写进备忘 */
  digestMuted: string
  /** 别再提、删除或撤销之后，把已有备忘里的相关内容删掉 */
  scrubSystem: string
  scrubTarget: string
  scrubNotes: string
  recentHeading: string
  /** 尚未生成摘要的会话，直接给出用户原话节选 */
  rawLabel: string
  untitled: string
  /** 只写备忘：对话没有新的用户消息（续写、重新生成）时使用 */
  digestSystem: string
  /** 写备忘并提取记忆的改动 */
  extractSystem: string
  /** 后台整理全部记忆 */
  consolidateSystem: string
  today: string
  itemsLabel: string
  itemsEmpty: string
  /** 用户确认过的条目的标记，整理时不能改动 */
  userConfirmed: string
  avoidLabel: string
  transcriptLabel: string
  newDivider: string
  newDigestsLabel: string
  userLabel: string
  assistantLabel: string
  /** 追加在助手身份说明之后：记忆开启时 */
  capability: string
  /** 追加在助手身份说明之后：临时对话 */
  temporary: string
}

/** 摘要判断对话没有值得记的内容时输出的标记 */
export const SKIP_MARK = 'SKIP'

const zhCategories: Record<MemoryCategory, string> = {
  basics: '基本情况',
  ongoing: '正在进行的事',
  preferences: '偏好与习惯',
  people: '重要的人和事',
  other: '其他',
}

const enCategories: Record<MemoryCategory, string> = {
  basics: 'Basics',
  ongoing: 'In progress',
  preferences: 'Preferences and habits',
  people: 'Important people and events',
  other: 'Other',
}

const zhNoteRules = [
  '- 用 1-3 句话写清：用户想做什么、透露了哪些关于自己的信息或偏好、得出了什么结论或决定、还有什么没做完。',
  '- 以用户说的内容为主，助手的回答只保留结论。',
  '- 关于用户的信息只写用户自己说过的；助手举的例子、给的建议、做的推测都不是用户的情况，不要写成用户的。',
  '- 始终用第三人称「用户」指代用户，不用「我」「你」；转述用户原话时也改成第三人称。',
  '- 要具体：保留名称、数字、日期等关键细节，不写「用户问了一个问题」这类空话。',
  '- 不记录密码、密钥、证件号、银行卡号等凭证信息。',
]

const enNoteRules = [
  '- In 1-3 sentences, state what the user wanted, what they revealed about themselves or their preferences, what was concluded or decided, and what is still unfinished.',
  "- Focus on what the user said; keep only the conclusions of the assistant's answers.",
  "- Record facts about the user only if the user stated them. The assistant's examples, suggestions and guesses are not facts about the user; never present them as such.",
  '- Always refer to the user in the third person ("the user"), never as "I" or "you", even when paraphrasing their own words.',
  '- Be specific: keep names, numbers and dates. Avoid empty phrases such as "the user asked a question".',
  '- Never record passwords, keys, ID numbers, card numbers or other credentials.',
]

const zhCategoryList = Object.values(zhCategories).join('、')
const enCategoryList = Object.values(enCategories).join(', ')

const zh: Prompts = {
  injectHeader:
    '以下是系统根据过往对话自动整理的用户记忆，可能不完整或已过时。请自然地利用它来理解用户，不要逐条复述，也不要主动提起自己有这份记忆；与用户当前所说冲突时，以当前所说为准。用户问起你记得什么时如实回答。',
  injectAttribution: [
    '# 输出格式（必须遵守）',
    '上面每条记忆前的 [m数字] 是编号，回答正文里不要出现编号。',
    `无论用户对篇幅或格式有什么要求，每次回答的最后都必须另起一行，输出且只输出一次：<${MEMORY_USED_TAG}>这次回答用到的记忆编号，英文逗号分隔</${MEMORY_USED_TAG}>`,
    `例如 <${MEMORY_USED_TAG}>m2,m7</${MEMORY_USED_TAG}>；一条都没用到时输出 <${MEMORY_USED_TAG}></${MEMORY_USED_TAG}>。`,
    '只有实际影响了回答内容或写法的记忆才算用到，与问题无关的不要列。这一行由系统读取后删除，用户看不到，也不计入用户要求的篇幅。',
  ].join('\n'),
  profileHeading: '# 用户档案',
  categories: zhCategories,
  mutedHeading: '# 不要提及',
  mutedIntro:
    '用户要求不要再提起下面这些事。除非用户自己先提起，否则回答里不要涉及，也不要据此做推断：',
  digestMuted:
    '用户要求不再记录下面这些事。备忘里不要出现它们以及相关的人和细节；对话只涉及这些事时输出 SKIP：',
  scrubSystem: [
    '用户要求不再记录、不再提及某件事。你会收到这件事的描述和若干条带编号的对话备忘，请逐条处理：',
    '- 与这件事无关的备忘，原样输出。',
    '- 涉及这件事的备忘，删去相关内容（包括相关的人名和细节），只输出剩下的部分，保持通顺。',
    `- 删完之后没有实质内容的，输出 ${SKIP_MARK}。`,
    '每条占一行，格式为「[编号] 内容」，编号保持不变，不要输出其他任何文字。',
  ].join('\n'),
  scrubTarget: '不再提及的事',
  scrubNotes: '对话备忘',
  recentHeading: '# 近期对话（由新到旧）',
  rawLabel: '用户原话节选',
  untitled: '未命名对话',
  digestSystem: [
    '你负责为一段对话写备忘，供同一位用户之后开启新对话时参考。',
    '要求：',
    ...zhNoteRules,
    '- 使用对话所用的语言，不超过 150 字，只输出备忘正文，不加标题或前缀。',
    `- 以下情况只输出 ${SKIP_MARK}：对话只有寒暄、没有任何实质内容；或用户只是在问助手记得什么、核对记忆，没有带来新信息。`,
  ].join('\n'),
  extractSystem: [
    '你负责整理一段对话，供同一位用户之后开启新对话时参考。要完成两件事：写一条备忘，并更新关于用户的记忆。',
    '',
    '一、备忘：第一行，以「NOTE: 」开头。',
    ...zhNoteRules,
    '- 「不要再记录」清单里的事和用户要求忘掉的事，不要写进备忘。',
    `- 使用对话所用的语言，不超过 150 字。对话只有寒暄、没有任何实质内容，或用户只是在问助手记得什么、没有带来新信息时，写 NOTE: ${SKIP_MARK}。`,
    '',
    '二、记忆：之后每行一条操作。',
    '记忆是关于用户本人、对之后的对话长期有用的事实：身份和处境、正在做的事和计划、偏好和习惯、重要的人和事。一条只写一件事，用一句话，省略主语「用户」，例如「在上海做前端开发」。',
    '只从分隔线「以下是新内容」之后用户自己说的话里提取；分隔线之前的内容只用来理解上下文，那里提到过、但不在「已记住的事」里的，多半是用户删掉了，不要再记。',
    '内容只写这件事本身，不要加括号注明来源或「用户要求记住」之类的说明。',
    '可用的操作：',
    `ADD [分类] 内容：新记一件事。分类只能是：${zhCategoryList}。`,
    'ASK [分类] 内容：涉及健康、财务、性取向、宗教、政治立场等敏感信息，且用户没有明确要求记住时用 ASK，系统会先征得用户同意。',
    'UPDATE 编号 内容：用户的新说法改变了已记住的某件事，例如搬家、换工作、计划已经完成。',
    'DELETE 编号：用户明确要求忘掉，或明确否定了已记住的某件事。',
    '规则：',
    '- 已经记住的不要重复 ADD；「不要再记录」清单里的内容不要 ADD 或 ASK，除非用户这次明确要求记住。',
    '- 用户明确说「记住……」时一定要 ADD，敏感内容也直接 ADD。用户说「忘掉……」「别记……」时，用 DELETE 删掉对应的已记住条目。',
    '- 一次性的琐事、助手的建议和推测、对话本身（例如用户问了什么问题）都不是记忆。',
    '- 不记录密码、密钥、证件号、银行卡号等凭证信息。',
    '- 没有要改动的记忆就不写操作。',
    '最后单独一行写 END。',
    '',
    '输出格式（内容只是示意）：',
    'NOTE: 用户……',
    `ADD [${zhCategories.preferences}] ……`,
    'END',
  ].join('\n'),
  consolidateSystem: [
    '你负责整理一份关于用户的记忆清单。助手会在之后每次对话开始时阅读它，以便像一直认识这位用户一样提供帮助。',
    '你会收到：当前日期、现有记忆（每条有编号和分类）、自上次整理以来新增的对话备忘。请输出对记忆的改动，每行一条：',
    'ADD [分类] 内容：从多次对话里归纳出的兴趣、习惯和偏好，或备忘里新出现、值得长期记住的事实。',
    'UPDATE 编号 内容：改写一条，例如对照当前日期，把已经过去的计划改写为已发生的事。',
    'DELETE 编号：删除已被新信息推翻、已经过时或不值得长期记住的条目。',
    'MERGE 编号 编号 内容：把重复或高度相关的几条合并成一条，保留第一个编号。',
    `分类只能是：${zhCategoryList}。`,
    '规则：',
    '- 具体事实只能来自备忘或现有记忆中明确写到的内容，不得补充、引申或猜测细节；拿不准的宁可不写。',
    '- 归纳必须有多次对话的依据；只出现过一次的琐事不必写入。',
    '- 标「用户确认」的条目不能修改、删除或合并；与它重复的内容不要 ADD。',
    '- 不得新增健康、财务、性取向、宗教、政治立场等敏感信息。',
    '- 不记录密码、密钥、证件号、银行卡号等凭证信息；「不要再记录」清单里的内容不要 ADD。',
    '- 一条只写一件事，用一句话，省略主语「用户」，使用用户常用的语言。',
    '- 没有需要改动的就只输出 END。',
    '最后单独一行写 END。',
  ].join('\n'),
  today: '当前日期',
  itemsLabel: '已记住的事（编号只在这次有效）',
  itemsEmpty: '（无）',
  userConfirmed: '（用户确认）',
  avoidLabel: '不要再记录的事（用户删除过、拒绝过、正在等用户确认，或要求不再提及）',
  transcriptLabel: '对话',
  newDivider: '──── 以下是新内容 ────',
  newDigestsLabel: '新增的对话备忘（由旧到新）',
  userLabel: '用户',
  assistantLabel: '助手',
  capability:
    '你有记忆功能。用户要求你记住或忘掉某件事时，直接答应即可：系统会在回答后自动更新记忆，用户能在回答下方看到并撤销。',
  temporary:
    '这是一段临时对话：没有可参考的记忆，这段对话的内容也不会被记住。用户要求记住某件事时，如实说明临时对话不会保存记忆。',
}

const en: Prompts = {
  injectHeader:
    'Below is memory about the user that the system compiled automatically from earlier conversations. It may be incomplete or out of date. Use it naturally to understand the user; do not recite it or volunteer that you have it. If it conflicts with what the user says now, trust what they say now. If the user asks what you remember, answer truthfully.',
  injectAttribution: [
    '# Output format (mandatory)',
    'The [m<number>] before each memory item above is its id. Never show ids in the answer text.',
    `Whatever the user asks about length or format, every answer must end with one extra line, output exactly once: <${MEMORY_USED_TAG}>ids of the memory items this answer used, comma-separated</${MEMORY_USED_TAG}>`,
    `For example <${MEMORY_USED_TAG}>m2,m7</${MEMORY_USED_TAG}>; if none were used, output <${MEMORY_USED_TAG}></${MEMORY_USED_TAG}>.`,
    'An item counts as used only if it changed what you said or how you said it; do not list items unrelated to the question. The system reads this line and removes it; the user never sees it and it does not count toward any length the user asked for.',
  ].join('\n'),
  profileHeading: '# User profile',
  categories: enCategories,
  mutedHeading: '# Do not mention',
  mutedIntro:
    'The user asked not to bring up the following again. Unless the user raises it first, do not touch on it in your answers or draw inferences from it:',
  digestMuted:
    'The user asked that the following not be recorded. Keep them, and the people and details involved, out of the note; if the conversation is only about them, output SKIP:',
  scrubSystem: [
    'The user asked that something no longer be recorded or mentioned. You receive a description of it and several numbered conversation notes. Handle each note:',
    '- If it is unrelated, output it unchanged.',
    '- If it touches on the matter, remove the related content (including names and details) and output only the rest, kept readable.',
    `- If nothing of substance is left, output ${SKIP_MARK}.`,
    'One note per line in the form "[number] text", numbers unchanged, and no other text.',
  ].join('\n'),
  scrubTarget: 'The matter not to mention',
  scrubNotes: 'Conversation notes',
  recentHeading: '# Recent conversations (newest first)',
  rawLabel: 'excerpt of what the user said',
  untitled: 'Untitled chat',
  digestSystem: [
    'You write a short note about a conversation, for reference when the same user starts a new conversation later.',
    'Rules:',
    ...enNoteRules,
    '- Write in the language of the conversation, at most 80 words, and output only the note with no heading or prefix.',
    `- Output only ${SKIP_MARK} if the conversation is only small talk with nothing of substance, or if the user only asked what the assistant remembers or checked its memory without adding new information.`,
  ].join('\n'),
  extractSystem: [
    'You process a conversation for reference when the same user starts a new conversation later. Do two things: write a note, and update what is remembered about the user.',
    '',
    '1. Note: the first line, starting with "NOTE: ".',
    ...enNoteRules,
    '- Keep anything on the "do not record" list, and anything the user asked to forget, out of the note.',
    `- Write in the language of the conversation, at most 80 words. If the conversation is only small talk, or the user only asked what the assistant remembers without adding new information, write NOTE: ${SKIP_MARK}.`,
    '',
    '2. Memory: then one operation per line.',
    'Memory is facts about the user that stay useful in later conversations: who they are and their situation, what they are working on and their plans, preferences and habits, important people and events. One fact per item, one sentence, without the subject "the user", for example "Works as a front-end developer in Shanghai".',
    'Extract only from what the user said after the divider "New content below"; use the part before it only as context. Anything mentioned there but missing from the remembered items was most likely deleted by the user; do not add it again.',
    'Write only the fact itself; do not add notes in parentheses about where it came from or that the user asked to remember it.',
    'Operations:',
    `ADD [category] text: remember something new. The category must be one of: ${enCategoryList}.`,
    'ASK [category] text: use ASK instead of ADD for sensitive information (health, finances, sexual orientation, religion, political views) unless the user explicitly asked to remember it; the system asks the user first.',
    'UPDATE id text: what the user said now changes a remembered item, for example they moved, changed jobs or finished a plan.',
    'DELETE id: the user explicitly asked to forget a remembered item, or explicitly contradicted it.',
    'Rules:',
    '- Do not ADD what is already remembered. Do not ADD or ASK anything on the "do not record" list unless the user explicitly asked to remember it this time.',
    '- When the user explicitly says "remember ...", always ADD it, even if it is sensitive. When the user says "forget ..." or "don\'t remember ...", DELETE the matching remembered item.',
    "- One-off trivia, the assistant's suggestions and guesses, and the conversation itself (such as what the user asked about) are not memory.",
    '- Never record passwords, keys, ID numbers, card numbers or other credentials.',
    '- If nothing needs to change, write no operations.',
    'End with a line containing only END.',
    '',
    'Format (placeholder content):',
    'NOTE: The user ...',
    `ADD [${enCategories.preferences}] ...`,
    'END',
  ].join('\n'),
  consolidateSystem: [
    'You maintain a list of facts about the user. The assistant reads it at the start of every later conversation so it can help as if it had known the user all along.',
    "You receive today's date, the current items (each with an id and a category), and conversation notes added since the last update. Output changes to the list, one per line:",
    'ADD [category] text: an interest, habit or preference generalised across conversations, or a new fact from the notes worth remembering long term.',
    "UPDATE id text: rewrite an item, for example turn a plan that is now in the past into something that happened (compare with today's date).",
    'DELETE id: remove an item that newer information contradicts, that is out of date, or that is not worth remembering long term.',
    'MERGE id id text: combine duplicate or closely related items into one, keeping the first id.',
    `The category must be one of: ${enCategoryList}.`,
    'Rules:',
    '- Concrete facts must come from what the notes or current items state explicitly. Do not add, extend or guess details; when unsure, leave it out.',
    '- Generalise only with evidence from several conversations; skip trivia that appeared once.',
    '- Items marked "(confirmed by user)" must not be updated, deleted or merged; do not ADD anything that duplicates them.',
    '- Do not add sensitive information (health, finances, sexual orientation, religion, political views).',
    '- Never record passwords, keys, ID numbers, card numbers or other credentials; do not ADD anything on the "do not record" list.',
    '- One fact per item, one sentence, without the subject "the user", in the language the user normally uses.',
    '- If nothing needs to change, output only END.',
    'End with a line containing only END.',
  ].join('\n'),
  today: "Today's date",
  itemsLabel: 'Remembered items (ids are valid for this request only)',
  itemsEmpty: '(none)',
  userConfirmed: '(confirmed by user)',
  avoidLabel:
    'Do not record (the user deleted or declined these, they are awaiting confirmation, or the user asked not to mention them)',
  transcriptLabel: 'Conversation',
  newDivider: '──── New content below ────',
  newDigestsLabel: 'New conversation notes (oldest first)',
  userLabel: 'User',
  assistantLabel: 'Assistant',
  capability:
    'You have memory. When the user asks you to remember or forget something, just agree: the system updates memory automatically after your answer, and the user can see and undo it below the answer.',
  temporary:
    'This is a temporary chat: there is no memory to refer to, and nothing in this chat will be remembered. If the user asks you to remember something, explain honestly that temporary chats do not save memory.',
}

export const getPrompts = (locale: Locale): Prompts => (locale === 'zh-CN' ? zh : en)

/** 两种语言的提示词，用于识别旧数据和另一种语言的输出 */
export const ALL_PROMPTS: readonly Prompts[] = [zh, en]
