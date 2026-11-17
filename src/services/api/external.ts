import type { ExternalProviderId, Protocol } from '../providers.js'
import { ApiError, request } from './client.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type { Effort, MessageStreamEvent, MessageUsage, StopReason } from './types.js'

/**
 * DeepSeek 以外的服务商：只发基础对话，把各自的流转换成应用内统一的 Messages 流式事件，
 * 上层的增量拼接、停止与落盘逻辑无需区分服务商。
 */

export type ExternalConfig = {
  provider: ExternalProviderId
  protocol: Protocol
  /** 不带结尾斜杠的接口地址 */
  baseUrl: string
  apiKey: string
}

export type ExternalMessage = { role: 'user' | 'assistant'; content: string }

export type ExternalRequest = {
  model: string
  system: string
  messages: ExternalMessage[]
  thinking: boolean
  effort: Effort
}

/** 流式请求没有超时顾虑，给模型留足输出空间 */
const ANTHROPIC_MAX_TOKENS = 64000

const loadAnthropic = async ({ apiKey, baseUrl }: ExternalConfig) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  return {
    Anthropic,
    // 静态页面没有后端，Key 由用户自己填写并只存在本机浏览器，直接从浏览器请求
    client: new Anthropic({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true }),
  }
}

type AnthropicModule = Awaited<ReturnType<typeof loadAnthropic>>['Anthropic']

const toApiError = (Anthropic: AnthropicModule, error: unknown): unknown => {
  if (error instanceof Anthropic.APIUserAbortError) {
    return error
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ApiError('network', error.message)
  }
  if (error instanceof Anthropic.APIError) {
    return new ApiError('http', error.message, error.status)
  }
  return error
}

async function* streamAnthropic(
  config: ExternalConfig,
  body: ExternalRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const { Anthropic, client } = await loadAnthropic(config)
  try {
    const stream = client.messages.stream(
      {
        model: body.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        ...(body.system ? { system: body.system } : {}),
        messages: body.messages,
        // 新模型的思考默认不返回文字；开启深度思考时要求返回摘要并按所选强度思考
        ...(body.thinking
          ? {
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: body.effort },
            }
          : {}),
      },
      { signal }
    )
    for await (const raw of stream) {
      const event = readMessageEvent(raw)
      if (!event) {
        continue
      }
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
  } catch (error) {
    throw toApiError(Anthropic, error)
  }
  throw new ApiError('interrupted', '')
}

type ChatCompletionChunk = {
  id?: string
  model?: string
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

const toStopReason = (reason: string): StopReason =>
  reason === 'length' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'end_turn'

const toUsage = (usage: NonNullable<ChatCompletionChunk['usage']>): MessageUsage => {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: usage.completion_tokens ?? 0,
  }
}

/** Chat Completions 流：reasoning_content / reasoning 归为思考块，content 归为文本块 */
async function* streamChatCompletions(
  config: ExternalConfig,
  body: ExternalRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: body.model,
      messages: [
        ...(body.system ? [{ role: 'system', content: body.system }] : []),
        ...body.messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
      ...(body.thinking ? { reasoning_effort: body.effort } : {}),
    }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', '')
  }
  let started = false
  let index = -1
  let open: 'thinking' | 'text' | null = null
  let stopReason: StopReason | null = null
  let usage: MessageUsage | undefined
  const events: MessageStreamEvent[] = []
  const append = (type: 'thinking' | 'text', text: string) => {
    if (open !== type) {
      if (open) {
        events.push({ type: 'content_block_stop', index })
      }
      index += 1
      open = type
      events.push({
        type: 'content_block_start',
        index,
        content_block:
          type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
      })
    }
    events.push({
      type: 'content_block_delta',
      index,
      delta:
        type === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text },
    })
  }
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let chunk: ChatCompletionChunk & { error?: { message?: string } }
    try {
      chunk = JSON.parse(data) as typeof chunk
    } catch {
      continue
    }
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message ?? data)
    }
    if (!started) {
      started = true
      events.push({
        type: 'message_start',
        message: { id: chunk.id ?? '', model: chunk.model ?? body.model },
      })
    }
    const choice = chunk.choices?.[0]
    const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
    if (reasoning) {
      append('thinking', reasoning)
    }
    if (choice?.delta?.content) {
      append('text', choice.delta.content)
    }
    if (choice?.finish_reason) {
      stopReason = toStopReason(choice.finish_reason)
    }
    if (chunk.usage) {
      usage = toUsage(chunk.usage)
    }
    yield* events.splice(0)
  }
  if (!stopReason) {
    // 没有收到结束原因就断流，按中断处理
    throw new ApiError('interrupted', '')
  }
  if (open) {
    yield { type: 'content_block_stop', index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}

export const streamExternal = (
  config: ExternalConfig,
  body: ExternalRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> =>
  config.protocol === 'anthropic'
    ? streamAnthropic(config, body, signal)
    : streamChatCompletions(config, body, signal)

/** 列出服务商的可用模型；同时用于校验 API Key */
export const listModels = async (
  config: ExternalConfig,
  signal?: AbortSignal
): Promise<string[]> => {
  if (config.protocol === 'anthropic') {
    const { Anthropic, client } = await loadAnthropic(config)
    try {
      const ids: string[] = []
      for await (const model of client.models.list({}, { signal })) {
        ids.push(model.id)
      }
      return ids
    } catch (error) {
      throw toApiError(Anthropic, error)
    }
  }
  const response = await request(`${config.baseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal,
  })
  const body = (await response.json()) as { data?: { id?: unknown }[] }
  return (
    (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string')
      // Gemini 的兼容接口返回 models/ 前缀，请求时不需要
      .map((id) => id.replace(/^models\//, ''))
  )
}
