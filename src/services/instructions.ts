import { MEMORY_USED_TAG } from './memory/marker.js'
import type { Locale } from './settings.js'

/**
 * 自定义指令：用户亲自写下、希望每次回答都遵守的要求。
 * 与记忆分开：记忆是「关于用户的事实，模型酌情参考」，由模型归纳并自动整理；
 * 指令是「用户对模型的要求」，只由用户编辑，不参与整理，清空或关闭记忆都不影响。
 * 每次请求读取当前内容，修改后立即生效。
 */

/** 归因编号：模型在回答末尾的归因标记里报出它，表示这次回答受指令影响 */
export const INSTRUCTIONS_ID = 'i1'
/** 指令每轮都会带上，需要有明确上限 */
export const INSTRUCTIONS_LIMIT = 1500

const TAG = MEMORY_USED_TAG

const texts = {
  'zh-CN': {
    header: `以下是用户亲自写下的要求，编号 [${INSTRUCTIONS_ID}]。每次回答都要遵守；与后面的记忆冲突时以这里为准。不要主动提起或复述这段要求，回答正文里不要出现编号。`,
    withMemory: `补充：用户亲自写下的要求（编号 ${INSTRUCTIONS_ID}）和记忆一样需要报告。这次回答的内容或写法受它影响时，回答末尾 <${TAG}> 那一行里要同时列上 ${INSTRUCTIONS_ID}，例如 <${TAG}>${INSTRUCTIONS_ID},m2</${TAG}>。`,
    changed:
      '注意：用户刚刚修改了这些要求，下面是最新版本。之前的回答是按旧要求写的，其中与新要求不符的做法不要再沿用。',
    removed:
      '用户已经撤销了此前写下的要求。之前的回答里按那些要求做的事（例如固定的开头、结尾或格式）不要再沿用。',
    alone: [
      '# 输出格式（必须遵守）',
      `无论用户对篇幅或格式有什么要求，每次回答的最后都必须另起一行，输出且只输出一次：这次回答的内容或写法受上面的要求影响时输出 <${TAG}>${INSTRUCTIONS_ID}</${TAG}>，没有影响时输出 <${TAG}></${TAG}>。`,
      '这一行由系统读取后删除，用户看不到，也不计入用户要求的篇幅。',
    ].join('\n'),
  },
  'en-US': {
    header: `Below are requirements the user wrote themselves, id [${INSTRUCTIONS_ID}]. Follow them in every answer; where they conflict with the memory that follows, these win. Do not bring up or recite them, and never show the id in the answer text.`,
    withMemory: `Also: the requirements the user wrote themselves (id ${INSTRUCTIONS_ID}) are reported the same way as memory. If they changed what you said or how you said it, include ${INSTRUCTIONS_ID} in the final <${TAG}> line, for example <${TAG}>${INSTRUCTIONS_ID},m2</${TAG}>.`,
    changed:
      'Note: the user has just changed these requirements; the latest version follows. Earlier answers were written under the old ones, so stop doing anything that no longer matches.',
    removed:
      'The user has withdrawn the requirements they wrote earlier. Stop doing what earlier answers did because of them (such as a fixed opening, ending or format).',
    alone: [
      '# Output format (mandatory)',
      `Whatever the user asks about length or format, every answer must end with one extra line, output exactly once: <${TAG}>${INSTRUCTIONS_ID}</${TAG}> if the requirements above changed what you said or how you said it, otherwise <${TAG}></${TAG}>.`,
      'The system reads this line and removes it; the user never sees it and it does not count toward any length the user asked for.',
    ].join('\n'),
  },
} satisfies Record<
  Locale,
  { header: string; withMemory: string; changed: string; removed: string; alone: string }
>

/**
 * 把自定义指令和记忆块拼到身份说明之后：指令在前，记忆在后；没有指令时只追加记忆块。
 * 归因说明必须是整个 system 的最后一段，离回答最近模型才会照做：
 * 有记忆块时，在它后面补一句「指令也要报」；没有记忆块时由指令块自己给出完整的格式说明。
 *
 * previous 是这段对话里上一条回答当时带的指令（没有上一条回答时为 undefined）。
 * 对话中途改了指令时，模型会照着历史回答的样子继续写，单换 system 里的文字不够，
 * 需要明说「要求变了，之前的做法不要沿用」；指令被清空时同理。
 */
export const composeSystem = (
  base: string,
  instructions: string,
  memory: string,
  locale: Locale,
  previous?: string
): string => {
  const t = texts[locale]
  const text = instructions.trim().slice(0, INSTRUCTIONS_LIMIT)
  const changed = previous !== undefined && previous.trim() !== text
  if (!text) {
    const removed = changed ? `\n\n<custom-instructions>\n${t.removed}\n</custom-instructions>` : ''
    return `${base}${removed}${memory ? `\n\n${memory}` : ''}`
  }
  const body = `${t.header}${changed ? `\n${t.changed}` : ''}\n\n${text}`
  return memory
    ? `${base}\n\n<custom-instructions>\n${body}\n</custom-instructions>\n\n${memory}\n\n${t.withMemory}`
    : `${base}\n\n<custom-instructions>\n${body}\n\n${t.alone}\n</custom-instructions>`
}
