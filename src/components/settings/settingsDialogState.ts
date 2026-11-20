import { create } from 'zustand'
import { activeApiKey } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 记忆 / 数据管理 */
export type SettingsSection = 'general' | 'memory' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

const RETURN_KEY = 'chat-demo:settings-return'

/**
 * 连接云端同步可能要跳转到服务商的授权页再回来（如 Dropbox），页面会重新加载。
 * 跳转前记下设置所在的分组，回来后重新打开，用户能直接看到连接结果。
 */
export const rememberSettingsForReturn = (section: SettingsSection) => {
  try {
    sessionStorage.setItem(RETURN_KEY, section)
  } catch {
    // 存储不可用时回来后不自动打开设置
  }
}

export const forgetSettingsForReturn = () => {
  try {
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // 同上
  }
}

/** 应用启动时调用：刚从授权页回来就重新打开设置 */
export const restoreSettingsAfterReturn = () => {
  let section: string | null = null
  try {
    section = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    return
  }
  if (section === 'general' || section === 'memory' || section === 'data') {
    openSettings(section)
  }
}

/** 当前服务商没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (activeApiKey()) {
    return true
  }
  openSettings('data')
  return false
}
