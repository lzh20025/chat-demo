import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel, Effort } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'
import {
  getProvider,
  isProviderId,
  resolveEffort,
  type ExternalProviderId,
  type ProviderId,
} from './providers.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** DeepSeek 以外各服务商的连接设置；接口地址缺省时使用服务商默认值 */
export type ProviderSettings = { apiKey?: string; model?: string; baseUrl?: string }

/** 本机设置，存 localStorage：服务商、API Key、语言、主题、位置、朗读音色、模型、思考强度、深度思考开关、侧边栏收起状态、自定义指令、记忆首次说明 */
type Settings = {
  /** DeepSeek 的 API Key；其他服务商的 Key 存在 providers 里，互不混用 */
  apiKey: string | null
  /** 当前对话使用的服务商，默认 DeepSeek */
  provider: ProviderId
  /** 最近一次选过的其他服务商，切回「其他服务商」时恢复 */
  otherProvider: ExternalProviderId
  providers: Partial<Record<ExternalProviderId, ProviderSettings>>
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  /** 新回复使用的模型 */
  model: ChatModel
  /** 新回复的思考强度，仅深度思考开启时生效 */
  effort: Effort
  thinking: boolean
  siderCollapsed: boolean
  /** 记忆开关；关闭后不注入、不生成，已保存的记忆保留 */
  memoryEnabled: boolean
  /** 自定义指令：用户希望每次回答都遵守的要求；空字符串表示没有 */
  customInstructions: string
  /**
   * 对话内记忆提示的首次说明：null 表示还没出现过记忆提示；
   * 消息 id 表示说明挂在这条回答的提示下方；done 表示用户已点「知道了」或打开过记忆设置
   */
  memoryIntro: string | null
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  provider: 'chat-demo:provider',
  otherProvider: 'chat-demo:other-provider',
  providers: 'chat-demo:providers',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  model: 'chat-demo:model',
  effort: 'chat-demo:effort',
  thinking: 'chat-demo:thinking',
  siderCollapsed: 'chat-demo:sider-collapsed',
  memoryEnabled: 'chat-demo:memory-enabled',
  customInstructions: 'chat-demo:custom-instructions',
  memoryIntro: 'chat-demo:memory-intro',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialProvider = (): ProviderId => {
  const saved = read(KEYS.provider)
  return isProviderId(saved) ? saved : 'deepseek'
}

const initialOtherProvider = (): ExternalProviderId => {
  const saved = read(KEYS.otherProvider)
  return isProviderId(saved) && saved !== 'deepseek' ? saved : 'anthropic'
}

const initialProviders = (): Settings['providers'] => {
  try {
    const value: unknown = JSON.parse(read(KEYS.providers) ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Settings['providers']) : {}
  } catch {
    return {}
  }
}

/** 未保存过时使用 deepseek-flash */
const initialModel = (): ChatModel =>
  read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'

/** 未保存过时使用服务端默认强度 high */
const initialEffort = (): Effort => {
  const saved = read(KEYS.effort)
  return saved === 'low' || saved === 'medium' || saved === 'xhigh' || saved === 'max'
    ? saved
    : 'high'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  provider: initialProvider(),
  otherProvider: initialOtherProvider(),
  providers: initialProviders(),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  model: initialModel(),
  effort: initialEffort(),
  thinking: read(KEYS.thinking) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  // 默认开启；只有明确关闭过才为 false
  memoryEnabled: read(KEYS.memoryEnabled) !== 'false',
  customInstructions: read(KEYS.customInstructions) ?? '',
  memoryIntro: read(KEYS.memoryIntro) || null,
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setProvider = (provider: ProviderId) => {
  write(KEYS.provider, provider)
  if (provider === 'deepseek') {
    useSettings.setState({ provider })
  } else {
    write(KEYS.otherProvider, provider)
    useSettings.setState({ provider, otherProvider: provider })
  }
}

export const setProviderSettings = (provider: ExternalProviderId, patch: ProviderSettings) => {
  const current = useSettings.getState().providers
  const providers = { ...current, [provider]: { ...current[provider], ...patch } }
  write(KEYS.providers, JSON.stringify(providers))
  useSettings.setState({ providers })
}

/** 当前服务商是否为 DeepSeek；搜索、附件、语音、标题和记忆只在这时可用 */
export const isNativeProvider = (state: Pick<Settings, 'provider'> = useSettings.getState()) =>
  state.provider === 'deepseek'

/** 当前服务商的 API Key */
export const activeApiKey = (
  state: Pick<Settings, 'provider' | 'providers' | 'apiKey'> = useSettings.getState()
): string | null =>
  state.provider === 'deepseek' ? state.apiKey : (state.providers[state.provider]?.apiKey ?? null)

/** 外部服务商的接口地址：用户填写的优先，否则用默认值；去掉结尾斜杠 */
export const providerBaseUrl = (
  provider: ExternalProviderId,
  state: Pick<Settings, 'providers'> = useSettings.getState()
) =>
  (state.providers[provider]?.baseUrl?.trim() || getProvider(provider).baseUrl).replace(/\/+$/, '')

/** 当前服务商下实际生效的思考强度 */
export const activeEffort = (
  state: Pick<Settings, 'provider' | 'effort'> = useSettings.getState()
) => resolveEffort(state.provider, state.effort)

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setEffort = (effort: Effort) => {
  write(KEYS.effort, effort)
  useSettings.setState({ effort })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setCustomInstructions = (value: string) => {
  const customInstructions = value.trim()
  write(KEYS.customInstructions, customInstructions || null)
  useSettings.setState({ customInstructions })
}

export const setMemoryEnabled = (memoryEnabled: boolean) => {
  write(KEYS.memoryEnabled, String(memoryEnabled))
  useSettings.setState({ memoryEnabled })
}

/** 第一次出现记忆提示时，把首次说明挂到这条回答上；已经挂过或已看过时不变 */
export const claimMemoryIntro = (messageId: string) => {
  if (useSettings.getState().memoryIntro === null) {
    write(KEYS.memoryIntro, messageId)
    useSettings.setState({ memoryIntro: messageId })
  }
}

/** 用户点了「知道了」或打开了记忆设置：首次说明不再显示 */
export const finishMemoryIntro = () => {
  if (useSettings.getState().memoryIntro !== 'done') {
    write(KEYS.memoryIntro, 'done')
    useSettings.setState({ memoryIntro: 'done' })
  }
}
