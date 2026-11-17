import { create } from 'zustand'
import { listModels } from './api/external.js'
import { getProvider, type ExternalProviderId } from './providers.js'
import { providerBaseUrl, setProviderSettings, useSettings } from './settings.js'

/** 各服务商的可用模型列表，校验 API Key 或打开模型设置时获取，只存在内存里 */
export const useProviderModels = create<Partial<Record<ExternalProviderId, string[]>>>(() => ({}))

/** Anthropic 没选过模型时的默认值 */
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'

/** 用给定的 Key 拉取模型列表；Key 无效或接口地址不可用时抛出 */
export const fetchProviderModels = async (provider: ExternalProviderId, apiKey: string) => {
  const baseUrl = providerBaseUrl(provider)
  const models = await listModels({
    provider,
    protocol: getProvider(provider).protocol,
    baseUrl,
    apiKey,
  })
  useProviderModels.setState({ [provider]: models })
  if (
    provider === 'anthropic' &&
    !useSettings.getState().providers.anthropic?.model &&
    models.includes(ANTHROPIC_DEFAULT_MODEL)
  ) {
    setProviderSettings('anthropic', { model: ANTHROPIC_DEFAULT_MODEL })
  }
  return models
}
