/**
 * 记忆归因标记。记忆块整段注入，模型在回答末尾用一行
 * `<memory-used>m2,m7</memory-used>` 报出这次实际用到的条目编号；
 * 这一行不属于回答：流式显示时隐藏，回答结束时从正文剥离并存为 `memoryUsed`。
 */
export const MEMORY_USED_TAG = 'memory-used'

const OPEN = `<${MEMORY_USED_TAG}>`
const COMPLETE = new RegExp(`\\s*<${MEMORY_USED_TAG}>([^<]*)</${MEMORY_USED_TAG}>`, 'g')
const UNCLOSED = new RegExp(`\\s*<${MEMORY_USED_TAG}>[^<]*(?:<[^>]*)?$`)

/**
 * 剥离正文里的归因标记。used 为 null 表示没有出现标记（回答被中断，或模型没有照做），
 * 空数组表示模型明确报告一条都没用到。
 */
export const extractMemoryUsed = (text: string): { text: string; used: string[] | null } => {
  let used: string[] | null = null
  const stripped = text.replace(COMPLETE, (_, ids: string) => {
    used = [...new Set(ids.match(/m\d+/g) ?? [])]
    return ''
  })
  return { text: used === null ? text : stripped, used }
}

/** 流式显示用：隐藏完整的标记，以及末尾还没输出完的半截标记 */
export const hideMemoryMarker = (text: string): string => {
  const visible = text.replace(COMPLETE, '').replace(UNCLOSED, '')
  // 末尾可能正停在开始标签的中间，例如 "<memo"
  for (let length = Math.min(OPEN.length - 1, visible.length); length > 0; length -= 1) {
    if (visible.endsWith(OPEN.slice(0, length))) {
      return visible.slice(0, -length).trimEnd()
    }
  }
  return visible
}
