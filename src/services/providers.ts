import type { Effort } from './api/types.js'

/**
 * 模型服务商。DeepSeek 是默认服务商，联网搜索、链接阅读、附件、语音、标题和记忆都依赖它的扩展接口；
 * 其他服务商只提供基础对话（含思考与强度设置），这些扩展功能在界面上隐藏。
 */
export type ProviderId = 'deepseek' | 'anthropic' | 'openai' | 'gemini' | 'custom'
export type ExternalProviderId = Exclude<ProviderId, 'deepseek'>

/** anthropic 走 Messages API（官方 SDK）；openai 走 Chat Completions 流式接口 */
export type Protocol = 'anthropic' | 'openai'

export type Provider = {
  id: ProviderId
  label: string
  protocol: Protocol
  /** 默认接口地址；custom 没有默认值，需用户填写 */
  baseUrl: string
  /** 可选的思考强度，按从低到高排列 */
  efforts: Effort[]
}

const DEEPSEEK: Provider = {
  id: 'deepseek',
  label: 'DeepSeek',
  protocol: 'anthropic',
  baseUrl: '',
  efforts: ['low', 'high', 'max'],
}

export const PROVIDERS: Provider[] = [
  DEEPSEEK,
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    protocol: 'openai',
    // Gemini 提供 OpenAI 兼容接口，无需单独实现协议
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible',
    protocol: 'openai',
    baseUrl: '',
    efforts: ['low', 'medium', 'high'],
  },
]

export const getProvider = (id: ProviderId): Provider =>
  PROVIDERS.find((provider) => provider.id === id) ?? DEEPSEEK

export const isProviderId = (value: unknown): value is ProviderId =>
  PROVIDERS.some((provider) => provider.id === value)

/** 所选强度不在服务商支持范围内时退回 high */
export const resolveEffort = (provider: ProviderId, effort: Effort): Effort =>
  getProvider(provider).efforts.includes(effort) ? effort : 'high'
