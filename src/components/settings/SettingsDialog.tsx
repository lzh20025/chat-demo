import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconMemoryOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportResult,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { useMemory } from '../../services/memory/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import { PROVIDERS, getProvider, type ExternalProviderId } from '../../services/providers.js'
import { fetchProviderModels, useProviderModels } from '../../services/providerModels.js'
import {
  activeEffort,
  isChineseBrowser,
  providerBaseUrl,
  setEffort,
  setLocale,
  setLocation,
  setModel,
  setProvider,
  setProviderSettings,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { InstructionsSetting } from './InstructionsSetting.js'
import { MemorySetting } from './MemorySetting.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（模型、思考强度、主题、语言、朗读音色、位置、自定义指令）、「记忆」（档案与近期对话摘要）与「数据管理」（服务商、API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'memory', label: 'settingDialogAsideMemoryOptionLabel', icon: <IconMemoryOutline16 /> },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ModelSetting />
              <EffortSetting />
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <InstructionsSetting />
            </>
          ) : section === 'memory' ? (
            <MemorySetting />
          ) : (
            <>
              <ProviderSetting />
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
/**
 * 服务商：默认 DeepSeek，另有「其他服务商」一项。
 * 选择其他服务商后再选具体是哪一家，并可改接口地址（自定义服务商必须填写）。
 */
const ProviderSetting = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const otherProvider = useSettings((state) => state.otherProvider)
  const label = t('settingsProvider')
  const other = provider !== 'deepseek'
  return (
    <>
      <div className={styles.theme}>
        {label}
        <div
          role="radiogroup"
          aria-label={label}
          className={clsx(styles.themeOptions, styles.providerOptions)}
        >
          <button
            type="button"
            role="radio"
            aria-checked={!other}
            className={clsx(styles.themeOption, !other && styles.themeOptionSelected)}
            onClick={() => setProvider('deepseek')}
          >
            DeepSeek
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={other}
            className={clsx(styles.themeOption, other && styles.themeOptionSelected)}
            onClick={() => setProvider(otherProvider)}
          >
            {t('settingsProviderOther')}
          </button>
        </div>
      </div>
      {provider === 'deepseek' ? null : (
        <>
          <SettingCell
            label={t('settingsProviderOther')}
            description={t('settingsProviderDescription')}
            status={null}
            action={
              <Select
                ariaLabel={t('settingsProviderOther')}
                value={provider}
                options={PROVIDERS.filter((item) => item.id !== 'deepseek').map((item) => ({
                  value: item.id,
                  label: item.label,
                }))}
                onChange={setProvider}
              />
            }
          />
          <TextSetting
            key={provider}
            label={t('settingsBaseUrl')}
            value={useSettings.getState().providers[provider]?.baseUrl ?? ''}
            placeholder={getProvider(provider).baseUrl || 'https://example.com/v1'}
            onCommit={(baseUrl) => setProviderSettings(provider, { baseUrl })}
          />
        </>
      )}
    </>
  )
}

/** 单行文本设置：失焦或回车时保存 */
const TextSetting = ({
  label,
  value,
  placeholder,
  options,
  onCommit,
}: {
  label: string
  value: string
  placeholder: string
  /** 可选的候选值，输入时提示 */
  options?: string[]
  onCommit: (value: string) => void
}) => {
  const [text, setText] = useState(value)
  const listId = `setting-options-${label}`
  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{label}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            aria-label={label}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            list={options?.length ? listId : undefined}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => onCommit(text.trim())}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.currentTarget.blur()
              }
            }}
          />
          {options?.length ? (
            <datalist id={listId}>
              {options.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const ModelSetting = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const model = useSettings((state) => state.model)
  return provider === 'deepseek' ? (
    <SettingCell
      label={t('settingsModel')}
      description={t('settingsModelDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsModel')}
          value={model}
          options={[
            { value: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
            { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
          ]}
          onChange={setModel}
        />
      }
    />
  ) : (
    <ExternalModelSetting key={provider} provider={provider} />
  )
}

/** 其他服务商的模型：手动填写模型 ID，已保存 Key 时提示服务商返回的模型列表 */
const ExternalModelSetting = ({ provider }: { provider: ExternalProviderId }) => {
  const t = useTranslate()
  const saved = useSettings((state) => state.providers[provider])
  const models = useProviderModels((state) => state[provider])
  const apiKey = saved?.apiKey
  useEffect(() => {
    if (apiKey && !models && providerBaseUrl(provider)) {
      // 列表只用于输入提示，获取失败不影响手动填写
      fetchProviderModels(provider, apiKey).catch(() => {})
    }
  }, [provider, apiKey, models])
  return (
    <TextSetting
      // 校验 Key 后可能自动填入默认模型
      key={saved?.model ?? ''}
      label={`${t('settingsModel')} (${getProvider(provider).label})`}
      value={saved?.model ?? ''}
      placeholder={t('settingsModelPlaceholder')}
      options={models}
      onCommit={(value) => setProviderSettings(provider, { model: value })}
    />
  )
}

const effortLabels = {
  low: 'settingsEffortLow',
  medium: 'settingsEffortMedium',
  high: 'settingsEffortHigh',
  xhigh: 'settingsEffortXhigh',
  max: 'settingsEffortMax',
} as const satisfies Record<string, TranslationKey>

const EffortSetting = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const effort = useSettings(activeEffort)
  return (
    <SettingCell
      label={t('settingsEffort')}
      description={t('settingsEffortDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsEffort')}
          value={effort}
          options={getProvider(provider).efforts.map((value) => ({
            value,
            label: t(effortLabels[value]),
          }))}
          onChange={setEffort}
        />
      }
    />
  )
}

const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="outlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

type ImportOutcome = ImportResult | 'failed' | null

/**
 * 导入结果的状态行：先说对话，再说记忆；归档里没有对话时只说记忆。
 * 由几段文案拼成，渲染时按当前语言翻译。记忆导入失败时对话已经导入，单独说明。
 */
const importStatus = (outcome: ImportOutcome, t: ReturnType<typeof useTranslate>): Status => {
  if (outcome === null) {
    return null
  }
  if (outcome === 'failed') {
    return { key: 'historyImportFailed', error: true }
  }
  const { added, skipped, memoryAdded, memoryFailed } = outcome
  const chats: TranslationMessage =
    skipped > 0
      ? { key: 'historyImportedSkipped', params: { count: added, skipped } }
      : { key: added === 1 ? 'historyImportedOne' : 'historyImported', params: { count: added } }
  const memoryOnly = added === 0 && skipped === 0
  if (memoryFailed) {
    return memoryOnly
      ? { key: 'historyImportMemoryFailed', error: true }
      : {
          key: 'historyImportedWithMemoryFailed',
          params: { chats: t(chats.key, chats.params) },
          error: true,
        }
  }
  if (memoryAdded === null) {
    return chats
  }
  const memory: TranslationMessage =
    memoryAdded === 0
      ? { key: 'historyImportedMemoryNone' }
      : memoryAdded === 1
        ? { key: 'historyImportedMemoryOne' }
        : { key: 'historyImportedMemory', params: { count: memoryAdded } }
  return memoryOnly
    ? memory
    : {
        key: 'historyImportedWithMemory',
        params: { chats: t(chats.key, chats.params), memory: t(memory.key, memory.params) },
      }
}

/** 选文件后先确认；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ImportOutcome>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await importHistory(file))
    } catch {
      setOutcome('failed')
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, outcome, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 合并：把选中文件里本地没有的会话添加进来，已有会话不变；文件里的记忆同样合并，重复的跳过。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={importStatus(historyImport.outcome, t)}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话、图片和记忆导出为 ZIP 文件并下载；没有对话但有记忆时也可以导出 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const noChats = useChatStore((state) => state.sessions.length === 0)
  // 与导出范围一致：已生效的条目或不再提及的事
  const noMemory = useMemory(
    (state) => !state.items.some((item) => item.status === 'saved') && !state.profile?.muted?.length
  )
  const empty = noChats && noMemory
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
