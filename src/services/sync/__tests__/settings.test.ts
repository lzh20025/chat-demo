import { beforeAll, describe, expect, it } from 'vitest'

/** settings.ts 在模块加载时读 localStorage：先放一个内存版，再动态导入 */
const storage = new Map<string, string>()
beforeAll(() => {
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  } satisfies Storage
})

const load = () => import('../../settings.js')

describe('synced settings', () => {
  it('never exports API keys', async () => {
    const settings = await load()
    settings.setApiKey('sk-deepseek-secret')
    settings.setProviderSettings('anthropic', {
      apiKey: 'sk-ant-secret',
      model: 'claude-fable-5-2',
      baseUrl: 'https://example.test',
    })
    settings.setProviderSettings('openai', { apiKey: 'sk-openai-secret' })
    settings.setThemePreference('dark')

    const exported = settings.exportSyncedSettings()
    const text = JSON.stringify(exported)
    expect(text).not.toContain('secret')
    expect(text).not.toContain('apiKey')
    expect(exported.themePreference).toBe('dark')
    expect(JSON.parse(exported.providers ?? '{}')).toEqual({
      anthropic: { model: 'claude-fable-5-2', baseUrl: 'https://example.test' },
    })
    expect(Object.keys(exported)).not.toContain('apiKey')
  })

  it('applies synced values without touching local API keys or unsynced settings', async () => {
    const settings = await load()
    settings.setSiderCollapsed(true)
    const before = settings.syncedSettingsModifiedAt()

    settings.applySyncedSettings(
      {
        themePreference: 'light',
        customInstructions: 'Be brief',
        providers: JSON.stringify({ anthropic: { model: 'other-model', apiKey: 'sk-injected' } }),
        // 白名单之外的键不写入
        ...({ apiKey: 'sk-injected', siderCollapsed: 'false' } as object),
      },
      before + 500
    )

    const state = settings.useSettings.getState()
    expect(state.themePreference).toBe('light')
    expect(state.customInstructions).toBe('Be brief')
    expect(state.apiKey).toBe('sk-deepseek-secret')
    expect(state.siderCollapsed).toBe(true)
    expect(state.providers.anthropic).toEqual({ apiKey: 'sk-ant-secret', model: 'other-model' })
    expect(state.providers.openai).toEqual({ apiKey: 'sk-openai-secret' })
    // 写回的设置不算本机改动：改动时间就是这份设置自带的时间
    expect(settings.syncedSettingsModifiedAt()).toBe(before + 500)
  })

  it('bumps the modified time only for synced settings', async () => {
    const settings = await load()
    const before = settings.syncedSettingsModifiedAt()
    settings.setSiderCollapsed(false)
    settings.setSyncEnabled(true)
    expect(settings.syncedSettingsModifiedAt()).toBe(before)
    settings.setLocale('en-US')
    expect(settings.syncedSettingsModifiedAt()).toBeGreaterThan(before)
  })
})
