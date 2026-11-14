import { streamMessage } from '../api/client.js'
import type { ChatModel } from '../api/types.js'

/** 记忆整理使用的模型：摘要和档案合成都是轻量任务 */
const MEMORY_MODEL: ChatModel = 'deepseek-flash'
const TIMEOUT = 60_000

/**
 * 一次性文本生成：system + 一条 user 消息，返回完整文本。
 * 记忆层对模型服务的全部依赖都在这一个函数里；接入其他服务时只需替换它。
 * 不开启思考、搜索与标题，结果不进入任何会话。
 */
export const complete = async ({
  apiKey,
  system,
  user,
  signal,
}: {
  apiKey: string
  system: string
  user: string
  signal?: AbortSignal
}): Promise<string> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    abort()
  }
  const timer = setTimeout(abort, TIMEOUT)
  let text = ''
  try {
    const events = streamMessage(
      apiKey,
      {
        model: MEMORY_MODEL,
        system,
        messages: [{ role: 'user', content: user }],
        thinking: { type: 'disabled' },
        tools: [],
        safety_check: { level: 'high' },
      },
      controller.signal
    )
    for await (const event of events) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      } else if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') {
        // 安全审核拒答时没有可用内容
        return ''
      }
    }
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
