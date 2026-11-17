import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { fetchProviderModels } from '../../services/providerModels.js'
import {
  providerBaseUrl,
  setApiKey,
  setProviderSettings,
  useSettings,
} from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先校验（DeepSeek 用 GET /models，其他服务商拉取模型列表），通过才保存到对应服务商 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      const { provider } = useSettings.getState()
      if (provider === 'deepseek') {
        await verifyApiKey(apiKey)
        setApiKey(apiKey)
      } else {
        if (!providerBaseUrl(provider)) {
          throw new ApiError('protocol', { key: 'providerBaseUrlMissing' })
        }
        // 拉取模型列表同时校验 Key
        await fetchProviderModels(provider, apiKey)
        setProviderSettings(provider, { apiKey })
      }
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
